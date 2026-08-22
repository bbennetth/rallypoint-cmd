import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { joinPort, type PublicAccessConsole, type PublicAccessStatus } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Logger } from '../logger.js'
import { panelState } from '../db/schema/index.js'
import type { OpSink } from './types.js'
import { PAL_SETTINGS_INI } from './constants.js'

// Minimal view of the instance manager (a structural type, to avoid a
// compose.ts import cycle). The playit agent is panel-scoped, but each
// server needs its own UDP tunnel, so the port is resolved for the server
// the caller is looking at (falling back to the first server that has a
// game port when no id is given).
interface ServerPortView {
  id: string
  installDir: string
  game: { settingsAdapter: string; ports: { name: string; port: number; join?: boolean }[] }
}
export interface InstancePortSource {
  list(): ServerPortView[]
}

const execFileAsync = promisify(execFile)

// Public Access via playit.gg: the panel drives the playit agent through
// the pinned root helper (rallypoint-cmd-playit, sudoers-whitelisted) and
// reads tunnel state from api.playit.gg with the agent secret. Everything
// here is manager-level (game-agnostic): it exposes whatever UDP port the
// game declares (PublicPort in the ini for Palworld).

export const PLAYIT_HELPER = '/usr/local/bin/rallypoint-cmd-playit'
// Cached last-known address, keyed per game port — with several games
// installed each has its own tunnel, so one shared cache row would leak
// another game's address into the fallback.
const addressCacheKey = (gamePort: number) => `public_access_address:${gamePort}`
const API_BASE = 'https://api.playit.gg'

export interface PublicAccessService {
  // serverId scopes the port/address lookup to that server's game (the
  // per-server dashboard passes it); omitted = first server with a game
  // port, preserving the single-server behavior.
  status(serverId?: string): Promise<PublicAccessStatus>
  // Long-op: install (if needed), generate a claim, surface the URL, wait
  // for approval, start the agent.
  enable(sink: OpSink, serverId?: string): Promise<void>
  disable(): Promise<void>
  // Diagnostics: panel↔playit trace (helper calls + API exchanges) and
  // the agent's recent journal.
  console(): Promise<PublicAccessConsole>
}

// Diagnostic trace ring buffer. Deliberately module-level so trace history
// survives service re-composition; capped; NEVER receives the secret (the
// tracer redacts anything matching a captured secret value).
const TRACE_MAX = 100
export class PlayitTrace {
  private entries: { ts: number; kind: 'api' | 'helper' | 'agent'; line: string }[] = []
  private redactions: string[] = []

  redact(value: string): void {
    if (value && !this.redactions.includes(value)) this.redactions.push(value)
  }

  add(kind: 'api' | 'helper' | 'agent', line: string): void {
    let clean = line
    for (const secret of this.redactions) clean = clean.split(secret).join('[secret]')
    this.entries.push({ ts: Date.now(), kind, line: clean })
    if (this.entries.length > TRACE_MAX) this.entries.shift()
  }

  list(): { ts: number; kind: 'api' | 'helper' | 'agent'; line: string }[] {
    return [...this.entries]
  }
}

// Pull a udp tunnel's public address out of a playit tunnels-list
// response. The API is community-documented, so parse defensively: walk
// any {tunnels: [...]} array and look for udp-ish entries targeting our
// port. Exported for fixture tests.
export function extractTunnelAddress(payload: unknown, gamePort: number): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const root = payload as Record<string, unknown>
  const data = (root.data ?? root) as Record<string, unknown>
  const tunnels = data.tunnels
  if (!Array.isArray(tunnels)) return null
  for (const t of tunnels) {
    if (typeof t !== 'object' || t === null) continue
    const tun = t as Record<string, unknown>
    const proto = String(tun.proto ?? tun.tunnel_type ?? tun.port_type ?? '').toLowerCase()
    if (proto && !proto.includes('udp') && !proto.includes('both')) continue
    const local = Number(
      tun.local_port ?? (tun.origin as Record<string, unknown> | undefined)?.local_port ?? NaN,
    )
    if (Number.isFinite(local) && local !== gamePort) continue
    // Address shapes seen in the wild: {domain, port_start} / {assigned_domain,
    // port} / alloc.assigned_srv
    const alloc = (tun.alloc ?? {}) as Record<string, unknown>
    const allocData = (alloc.data ?? alloc) as Record<string, unknown>
    const host = String(
      tun.domain ?? tun.assigned_domain ?? allocData.assigned_domain ?? allocData.ip_hostname ?? '',
    )
    const port = Number(
      tun.port_start ?? tun.port ?? allocData.port_start ?? allocData.port ?? NaN,
    )
    if (host && Number.isFinite(port)) return `${host}:${port}`
    const srv = String(allocData.assigned_srv ?? tun.assigned_srv ?? '')
    if (srv) return srv
  }
  return null
}

// Resolve the game's UDP port from the first server that has one. For a
// Palworld server the live PublicPort in its ini wins; otherwise the
// registry default. Null when no server exposes a game port.
// Exported for fixture tests.
export function readGamePort(instances: InstancePortSource, serverId?: string): number | null {
  for (const inst of instances.list()) {
    if (serverId && inst.id !== serverId) continue
    const port = joinPort(inst.game.ports)
    if (port === null) continue
    if (inst.game.settingsAdapter === 'palworld-ini') {
      try {
        const ini = fs.readFileSync(path.join(inst.installDir, PAL_SETTINGS_INI), 'utf8')
        const m = ini.match(/PublicPort\s*=\s*(\d+)/)
        if (m) return Number(m[1])
      } catch {
        // ini not present yet — fall through to the registry default
      }
    }
    return port
  }
  return null
}

interface Deps {
  db: Db
  logger: Logger
  instances: InstancePortSource
}

export function createRealPublicAccess(deps: Deps): PublicAccessService {
  const { db, logger, instances } = deps
  let pendingClaim: { code: string; url: string } | null = null
  const trace = new PlayitTrace()

  async function helper(...args: string[]): Promise<{ ok: boolean; stdout: string }> {
    const verb = args[0] ?? '?'
    try {
      const { stdout } = await execFileAsync('sudo', ['-n', PLAYIT_HELPER, ...args], {
        timeout: args[0] === 'claim' ? 330_000 : args[0] === 'install' ? 300_000 : 30_000,
      })
      // `secret` output is the secret itself — never trace its value.
      if (verb !== 'secret' && verb !== 'logs') {
        trace.add('helper', `$ playit-helper ${verb} → ok${stdout ? `: ${stdout.split('\n')[0]}` : ''}`)
      }
      return { ok: true, stdout: stdout.trim() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('playit helper failed', { args: verb, err: msg })
      trace.add('helper', `$ playit-helper ${verb} → FAILED: ${msg.slice(0, 200)}`)
      return { ok: false, stdout: '' }
    }
  }

  async function helperStatus(): Promise<{ installed: boolean; claimed: boolean; running: boolean }> {
    if (!fs.existsSync(PLAYIT_HELPER)) return { installed: false, claimed: false, running: false }
    const res = await helper('status')
    if (!res.ok) return { installed: false, claimed: false, running: false }
    const kv = Object.fromEntries(res.stdout.split(/\s+/).map((p) => p.split('=')))
    return {
      installed: kv.installed === '1',
      claimed: kv.claimed === '1',
      running: kv.active === 'active',
    }
  }

  async function fetchAddress(gamePort: number): Promise<string | null> {
    const secret = await helper('secret')
    if (!secret.ok || !secret.stdout) {
      trace.add('api', 'skipped tunnels/list — no agent secret available')
      return null
    }
    trace.redact(secret.stdout)
    try {
      const res = await fetch(`${API_BASE}/tunnels/list`, {
        method: 'POST',
        headers: {
          authorization: `agent-key ${secret.stdout}`,
          'content-type': 'application/json',
          'user-agent': 'rallypoint-cmd',
        },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        trace.add('api', `POST /tunnels/list → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
        return null
      }
      const body: unknown = await res.json()
      const address = extractTunnelAddress(body, gamePort)
      if (address === null) {
        // The exact live-debugging breadcrumb we need: what did the API
        // actually return when our parser found nothing?
        trace.add(
          'api',
          `POST /tunnels/list → 200, but no udp tunnel matched port ${gamePort}. Body: ${JSON.stringify(body).slice(0, 500)}`,
        )
      } else {
        trace.add('api', `POST /tunnels/list → 200, address ${address}`)
      }
      if (address) {
        db.insert(panelState)
          .values({ key: addressCacheKey(gamePort), value: address, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: panelState.key,
            set: { value: address, updatedAt: new Date() },
          })
          .run()
      }
      return address
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('playit tunnels list failed', { err: msg })
      trace.add('api', `POST /tunnels/list → ERROR: ${msg.slice(0, 300)}`)
      return null
    }
  }

  function cachedAddress(gamePort: number): string | null {
    const row = db.select().from(panelState).where(eq(panelState.key, addressCacheKey(gamePort))).get()
    return row?.value ?? null
  }

  return {
    async status(serverId?: string): Promise<PublicAccessStatus> {
      const s = await helperStatus()
      const gamePort = readGamePort(instances, serverId) ?? 8211
      let address: string | null = null
      if (s.claimed) {
        address = (await fetchAddress(gamePort)) ?? cachedAddress(gamePort)
      }
      return {
        installed: s.installed,
        claimed: s.claimed,
        running: s.running,
        address,
        pendingClaim,
        gamePort,
      }
    },

    async enable(sink, serverId): Promise<void> {
      const s = await helperStatus()
      if (!fs.existsSync(PLAYIT_HELPER)) {
        throw new Error(
          'The playit helper is not installed — update the panel via the installer one-liner first.',
        )
      }
      if (!s.installed) {
        sink.line('[public-access] Installing the playit agent (apt)...')
        sink.progress(5)
        const inst = await helper('install')
        if (!inst.ok) throw new Error('playit agent installation failed (see panel logs).')
      }
      sink.progress(20)

      if (!s.claimed) {
        // Generate a claim code locally (unprivileged) and surface the URL.
        sink.line('[public-access] Generating claim code...')
        const gen = await execFileAsync('playit', ['claim', 'generate'], { timeout: 30_000 })
        const code = gen.stdout.trim().split(/\s+/).pop() ?? ''
        if (!/^[a-z0-9]{4,64}$/.test(code)) throw new Error(`Unexpected claim code: ${code}`)
        const url = `https://playit.gg/claim/${code}`
        pendingClaim = { code, url }
        sink.line(`[public-access] APPROVE THIS AGENT: ${url}`)
        sink.line('[public-access] Waiting for approval (up to 5 minutes)...')
        sink.progress(30)
        try {
          // Blocks until approved (helper runs `claim exchange --wait 300`,
          // writes the returned secret to /etc/playit/playit.toml — the CLI
          // only prints it — and restarts the agent).
          const claim = await helper('claim', code)
          if (!claim.ok) throw new Error('Claim was not approved in time — try again.')
        } finally {
          pendingClaim = null
        }
        sink.line('[public-access] Claimed — agent starting.')
      } else {
        await helper('start')
      }
      sink.progress(80)

      const gamePort = readGamePort(instances, serverId) ?? 8211
      const address = await fetchAddress(gamePort)
      if (address) {
        sink.line(`[public-access] Public address: ${address}`)
      } else {
        sink.line(
          `[public-access] Agent running. No UDP tunnel for port ${gamePort} found yet — create one at https://playit.gg/account/tunnels (UDP → 127.0.0.1:${gamePort}); the panel will pick up the address automatically.`,
        )
      }
      sink.progress(100)
    },

    async disable(): Promise<void> {
      const res = await helper('stop')
      if (!res.ok) throw new Error('Failed to stop the playit agent.')
    },

    async console(): Promise<PublicAccessConsole> {
      let agentLog: string[] = []
      if (fs.existsSync(PLAYIT_HELPER)) {
        const logs = await helper('logs')
        agentLog = logs.ok && logs.stdout ? logs.stdout.split('\n').slice(-200) : []
      }
      return { trace: trace.list(), agentLog }
    },
  }
}

// Mock: walks the full enable flow (install → claim URL → claimed →
// address) so the UI is fully drivable in PANEL_MODE=mock.
export function createFakePublicAccess(instances?: InstancePortSource): PublicAccessService {
  const state = {
    installed: false,
    claimed: false,
    running: false,
    address: null as string | null,
    pendingClaim: null as { code: string; url: string } | null,
  }
  const fakeTrace = new PlayitTrace()
  const delay = process.env.NODE_ENV === 'test' ? 0 : 700
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  return {
    status(serverId?: string) {
      const gamePort = (instances && readGamePort(instances, serverId)) ?? 8211
      return Promise.resolve({ ...state, gamePort })
    },
    async enable(sink) {
      if (!state.installed) {
        sink.line('[public-access] Installing the playit agent (apt)...')
        fakeTrace.add('helper', '$ playit-helper install → ok: playit installed')
        await sleep(delay)
        state.installed = true
      }
      sink.progress(20)
      if (!state.claimed) {
        const code = 'fakeclaim1234'
        state.pendingClaim = { code, url: `https://playit.gg/claim/${code}` }
        sink.line(`[public-access] APPROVE THIS AGENT: https://playit.gg/claim/${code}`)
        sink.progress(30)
        await sleep(delay * 3)
        state.pendingClaim = null
        state.claimed = true
        sink.line('[public-access] Claimed — agent starting.')
      }
      state.running = true
      fakeTrace.add('helper', '$ playit-helper claim → ok: claimed and started')
      sink.progress(80)
      await sleep(delay)
      state.address = 'craft-fake.ply.gg:52801'
      fakeTrace.add('api', `POST /tunnels/list → 200, address ${state.address}`)
      sink.line(`[public-access] Public address: ${state.address}`)
      sink.progress(100)
    },
    disable() {
      state.running = false
      fakeTrace.add('helper', '$ playit-helper stop → ok')
      return Promise.resolve()
    },
    console() {
      return Promise.resolve({
        trace: fakeTrace.list(),
        agentLog: state.installed
          ? [
              '2026-08-02T18:00:01+0000 playit[321]: agent connected to relay us-west',
              '2026-08-02T18:00:02+0000 playit[321]: tunnel udp 8211 ready (craft-fake.ply.gg:52801)',
            ]
          : [],
      })
    },
  }
}
