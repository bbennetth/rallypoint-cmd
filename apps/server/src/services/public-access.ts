import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { PublicAccessStatus } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import { panelState } from '../db/schema/index.js'
import type { OpSink } from './types.js'
import { PAL_SETTINGS_INI } from './constants.js'

const execFileAsync = promisify(execFile)

// Public Access via playit.gg: the panel drives the playit agent through
// the pinned root helper (rallypoint-cmd-playit, sudoers-whitelisted) and
// reads tunnel state from api.playit.gg with the agent secret. Everything
// here is manager-level (game-agnostic): it exposes whatever UDP port the
// game declares (PublicPort in the ini for Palworld).

export const PLAYIT_HELPER = '/usr/local/bin/rallypoint-cmd-playit'
const ADDRESS_CACHE_KEY = 'public_access_address'
const API_BASE = 'https://api.playit.gg'

export interface PublicAccessService {
  status(): Promise<PublicAccessStatus>
  // Long-op: install (if needed), generate a claim, surface the URL, wait
  // for approval, start the agent.
  enable(sink: OpSink): Promise<void>
  disable(): Promise<void>
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

function readGamePort(env: Env): number | null {
  try {
    const ini = fs.readFileSync(path.join(env.PAL_DIR, PAL_SETTINGS_INI), 'utf8')
    const m = ini.match(/PublicPort\s*=\s*(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

interface Deps {
  env: Env
  db: Db
  logger: Logger
}

export function createRealPublicAccess(deps: Deps): PublicAccessService {
  const { env, db, logger } = deps
  let pendingClaim: { code: string; url: string } | null = null

  async function helper(...args: string[]): Promise<{ ok: boolean; stdout: string }> {
    try {
      const { stdout } = await execFileAsync('sudo', ['-n', PLAYIT_HELPER, ...args], {
        timeout: args[0] === 'claim' ? 330_000 : args[0] === 'install' ? 300_000 : 30_000,
      })
      return { ok: true, stdout: stdout.trim() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('playit helper failed', { args: args[0], err: msg })
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
    if (!secret.ok || !secret.stdout) return null
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
      if (!res.ok) return null
      const address = extractTunnelAddress(await res.json(), gamePort)
      if (address) {
        db.insert(panelState)
          .values({ key: ADDRESS_CACHE_KEY, value: address, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: panelState.key,
            set: { value: address, updatedAt: new Date() },
          })
          .run()
      }
      return address
    } catch (err) {
      logger.warn('playit tunnels list failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  function cachedAddress(): string | null {
    const row = db.select().from(panelState).where(eq(panelState.key, ADDRESS_CACHE_KEY)).get()
    return row?.value ?? null
  }

  return {
    async status(): Promise<PublicAccessStatus> {
      const s = await helperStatus()
      const gamePort = readGamePort(env) ?? 8211
      let address: string | null = null
      if (s.claimed) {
        address = (await fetchAddress(gamePort)) ?? cachedAddress()
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

    async enable(sink): Promise<void> {
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
          // Blocks until approved (helper runs `claim exchange --wait 300`
          // as root so the secret lands in the system path), then starts.
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

      const gamePort = readGamePort(env) ?? 8211
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
  }
}

// Mock: walks the full enable flow (install → claim URL → claimed →
// address) so the UI is fully drivable in PANEL_MODE=mock.
export function createFakePublicAccess(): PublicAccessService {
  const state = {
    installed: false,
    claimed: false,
    running: false,
    address: null as string | null,
    pendingClaim: null as { code: string; url: string } | null,
  }
  const delay = process.env.NODE_ENV === 'test' ? 0 : 700
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  return {
    status() {
      return Promise.resolve({ ...state, gamePort: 8211 })
    },
    async enable(sink) {
      if (!state.installed) {
        sink.line('[public-access] Installing the playit agent (apt)...')
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
      sink.progress(80)
      await sleep(delay)
      state.address = 'craft-fake.ply.gg:52801'
      sink.line(`[public-access] Public address: ${state.address}`)
      sink.progress(100)
    },
    disable() {
      state.running = false
      return Promise.resolve()
    },
  }
}
