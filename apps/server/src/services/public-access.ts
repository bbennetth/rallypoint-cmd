import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { joinPort, type PublicAccessConsole, type PublicAccessStatus } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Logger } from '../logger.js'
import { panelState } from '../db/schema/index.js'
import type { OpSink } from './types.js'
import { PAL_SETTINGS_INI } from './constants.js'
import * as playit from './playit-agent.js'

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

// Public Access via playit.gg: the panel drives the playit agent
// directly (see playit-agent.ts) and reads tunnel state from
// api.playit.gg with the agent secret. Everything here is manager-level
// (game-agnostic): it exposes whatever UDP port the game declares
// (PublicPort in the ini for Palworld).

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

  // Runs one agent operation, tracing the outcome. The trace is
  // user-visible (the card's Console toggle), so it records what was
  // attempted and how it ended, never any secret value.
  async function step<T>(verb: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn()
      trace.add('helper', `$ playit ${verb} → ok`)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('playit agent op failed', { verb, err: msg })
      trace.add('helper', `$ playit ${verb} → FAILED: ${msg.slice(0, 200)}`)
      return null
    }
  }

  async function agentStatus(): Promise<{ installed: boolean; claimed: boolean; running: boolean }> {
    try {
      return await playit.status()
    } catch (err) {
      logger.warn('playit status failed', { err: err instanceof Error ? err.message : String(err) })
      return { installed: false, claimed: false, running: false }
    }
  }

  async function fetchAddress(gamePort: number): Promise<string | null> {
    const secret = playit.readSecret()
    if (!secret) {
      trace.add('api', 'skipped tunnels/list — no agent secret available')
      return null
    }
    trace.redact(secret)
    try {
      const res = await fetch(`${API_BASE}/tunnels/list`, {
        method: 'POST',
        headers: {
          authorization: `agent-key ${secret}`,
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
      const s = await agentStatus()
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
      const s = await agentStatus()
      if (!s.installed) {
        sink.line('[public-access] Installing the playit agent (apt)...')
        sink.progress(5)
        const inst = await step('install', () => playit.install())
        if (inst === null) throw new Error('playit agent installation failed (see panel logs).')
      }
      sink.progress(20)

      if (!s.claimed) {
        sink.line('[public-access] Generating claim code...')
        const code = await playit.generateClaimCode()
        const url = `https://playit.gg/claim/${code}`
        pendingClaim = { code, url }
        sink.line(`[public-access] APPROVE THIS AGENT: ${url}`)
        sink.line('[public-access] Waiting for approval (up to 5 minutes)...')
        sink.progress(30)
        try {
          // Blocks until approved: `claim exchange --wait 300` only PRINTS
          // the secret, so playit.claim() also persists it to
          // /etc/playit/playit.toml and restarts the agent.
          const claimed = await step('claim', () => playit.claim(code))
          if (claimed === null) throw new Error('Claim was not approved in time — try again.')
        } finally {
          pendingClaim = null
        }
        sink.line('[public-access] Claimed — agent starting.')
      } else {
        await step('start', () => playit.start())
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
      const res = await step('stop', () => playit.stop())
      if (res === null) throw new Error('Failed to stop the playit agent.')
    },

    async console(): Promise<PublicAccessConsole> {
      const agentLog = playit.playitBinPath() ? (await playit.logs()).slice(-200) : []
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
