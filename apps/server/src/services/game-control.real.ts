import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { GameControl, SystemdStatus } from './types.js'
import { SYSTEMCTL_BIN, assertAllowedUnit, type SystemctlVerb } from './constants.js'

export interface GameControlTarget {
  unitName: string
  installDir: string
  // Relative path whose presence means "installed" (from the registry).
  installedProbe: string
}

const execFileAsync = promisify(execFile)

// Parse an `ActiveEnterTimestamp` value from `systemctl show`. We request
// `--timestamp=unix` so systemd emits `@<epoch-seconds>` (robust, tz-free);
// but we also tolerate the human form ("Sat 2026-07-20 03:20:05 UTC") in
// case an older systemd ignores the flag. Returns epoch ms, or null.
// Exported for unit testing.
export function parseSystemdTimestamp(raw: string | undefined): number | null {
  if (!raw) return null
  const s = raw.trim()
  if (s === '' || s === '0' || s.toLowerCase() === 'n/a') return null
  const unix = s.match(/^@(\d+)$/)
  if (unix) return Number(unix[1]) * 1000
  // Strip a leading weekday abbreviation, then parse. Prefer an explicit
  // UTC → ISO conversion (V8's Date.parse of "YYYY-MM-DD HH:MM:SS UTC" is
  // unreliable); fall back to Date.parse for anything else.
  const human = s.replace(/^[A-Za-z]{2,4}\s+/, '')
  const utc = human.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC$/)
  const ms = utc ? Date.parse(`${utc[1]}T${utc[2]}Z`) : Date.parse(human)
  return Number.isFinite(ms) ? ms : null
}

// Real systemd control. The panel runs as an unprivileged user; only
// start/stop/restart go through sudo (unit names pinned in sudoers).
// Status reads are unprivileged D-Bus queries.

export function createRealGameControl(_env: Env, logger: Logger, target: GameControlTarget): GameControl {
  assertAllowedUnit(target.unitName)
  const unit = target.unitName

  async function sudoSystemctl(verb: SystemctlVerb): Promise<void> {
    try {
      // `restart` blocks until the unit is down+up again; a game can take
      // ~90s to flush its save on stop, so give the job room.
      await execFileAsync('sudo', ['-n', SYSTEMCTL_BIN, verb, unit], { timeout: 180_000 })
      logger.info('systemctl ok', { verb, unit })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('systemctl failed', { verb, unit, err: msg })
      throw new Error(`systemctl ${verb} ${unit} failed: ${msg}`)
    }
  }

  async function status(): Promise<SystemdStatus> {
    const installed = fs.existsSync(path.join(target.installDir, target.installedProbe))
    try {
      const { stdout } = await execFileAsync(
        SYSTEMCTL_BIN,
        [
          // Emit timestamps as `@<epoch>` so we don't parse locale/tz text.
          '--timestamp=unix',
          'show',
          unit,
          '-p',
          'ActiveState',
          '-p',
          'SubState',
          '-p',
          'MemoryCurrent',
          '-p',
          'ActiveEnterTimestamp',
        ],
        { timeout: 10_000 },
      )
      const props = new Map<string, string>()
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) props.set(line.slice(0, idx), line.slice(idx + 1).trim())
      }
      const memRaw = props.get('MemoryCurrent') ?? ''
      // systemd reports `[not set]` or the uint64-max sentinel
      // (18446744073709551615) when the unit is down — both must map to
      // null, not ~18 EiB. Only accept a safe-integer byte count.
      const memNum = Number(memRaw)
      const memory = /^\d+$/.test(memRaw) && Number.isSafeInteger(memNum) ? memNum : null
      return {
        installed,
        activeState: props.get('ActiveState') ?? 'inactive',
        subState: props.get('SubState') ?? 'dead',
        memoryCurrentBytes: memory,
        activeEnterAtMs: parseSystemdTimestamp(props.get('ActiveEnterTimestamp')),
      }
    } catch (err) {
      logger.warn('systemctl show failed', { err: err instanceof Error ? err.message : String(err) })
      return {
        installed,
        activeState: 'inactive',
        subState: 'unknown',
        memoryCurrentBytes: null,
        activeEnterAtMs: null,
      }
    }
  }

  return {
    start: () => sudoSystemctl('start'),
    stop: () => sudoSystemctl('stop'),
    restart: () => sudoSystemctl('restart'),
    status,
    waitFor: async (state, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const s = await status()
        const match = state === 'active' ? s.activeState === 'active' : s.activeState !== 'active' && s.activeState !== 'deactivating'
        if (match) return true
        if (Date.now() >= deadline) return false
        await new Promise((r) => setTimeout(r, 500))
      }
    },
  }
}
