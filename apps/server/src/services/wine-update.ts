import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import type { WineStatus } from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { OpSink } from './types.js'
import { formatApplyFailure } from './panel-update.js'

const execFileAsync = promisify(execFile)

// Panel-driven Wine upgrade: Debian wine -> WineHQ staging.
//
// Windows-platform game servers (Enshrouded) run under Wine, and Debian's
// build has neither esync nor fsync — WINEESYNC/WINEFSYNC in the generated
// start.sh are ignored and wineserver becomes the contention point that
// starves the game's tick loop. WineHQ's staging build has both.
//
// This is the same work install/rallypoint-cmd-install.sh's
// install_winehq_staging() does at CT creation; this service exists so an
// already-created CT can be upgraded from the panel. The panel runs as root
// (rallypoint-cmd.service has no User=), so apt-get is callable directly.

const WINEHQ_KEY_URL = 'https://dl.winehq.org/wine-builds/winehq.key'
const KEYRING_DIR = '/etc/apt/keyrings'
const KEYRING_PATH = '/etc/apt/keyrings/winehq-archive.key'
const SOURCES_PATH = '/etc/apt/sources.list.d/winehq.sources'
const OS_RELEASE_PATH = '/etc/os-release'
// The codenames WineHQ publishes a Debian repo for that we install onto.
const SUPPORTED_CODENAMES = ['bookworm', 'trixie']

export interface WineUpdateService {
  status(): Promise<WineStatus>
  run(sink: OpSink): Promise<void>
}

// `wine --version` prints one line, e.g. "wine-10.0 (Staging)" or plain
// "wine-8.0". Staging builds are the only ones that say so. Exported for
// unit tests.
export function parseWineVersion(stdout: string): { version: string | null; staging: boolean } {
  const version = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^wine-/i.test(l))
  if (!version) return { version: null, staging: false }
  return { version, staging: /staging/i.test(version) }
}

// Only Debian codenames with a WineHQ repo we install onto can be upgraded.
// Tolerates a missing/garbage os-release by returning false. Exported for
// unit tests.
export function codenameSupported(osRelease: string): boolean {
  const codename = readCodename(osRelease)
  return codename !== null && SUPPORTED_CODENAMES.includes(codename)
}

// VERSION_CODENAME=bookworm (may be quoted). Null when absent.
export function readCodename(osRelease: string): string | null {
  const m = osRelease.match(/^VERSION_CODENAME=(.*)$/m)
  if (!m) return null
  const value = m[1]!.trim().replace(/^["']|["']$/g, '')
  return value.length > 0 ? value : null
}

interface Deps {
  env: Env
  logger: Logger
}

export function createRealWineUpdate(deps: Deps): WineUpdateService {
  const { logger } = deps

  function osRelease(): string {
    try {
      return fs.readFileSync(OS_RELEASE_PATH, 'utf8')
    } catch {
      return ''
    }
  }

  // Resolve the loader the generated start.sh uses: wine64 first, then wine.
  async function probeWine(): Promise<{ version: string | null; staging: boolean }> {
    for (const bin of ['wine64', 'wine']) {
      try {
        const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 15_000 })
        const parsed = parseWineVersion(stdout)
        if (parsed.version) return parsed
      } catch {
        // Not on PATH (or refused to run) — try the next loader.
      }
    }
    return { version: null, staging: false }
  }

  async function currentStatus(): Promise<WineStatus> {
    const { version, staging } = await probeWine()
    return {
      installed: version !== null,
      version,
      staging,
      upgradeSupported: codenameSupported(osRelease()),
    }
  }

  return {
    status: currentStatus,

    async run(sink): Promise<void> {
      const codename = readCodename(osRelease())
      if (codename === null || !SUPPORTED_CODENAMES.includes(codename)) {
        throw new Error(
          `WineHQ staging is not supported on this system (Debian codename ${codename ?? 'unknown'}). ` +
            `Supported: ${SUPPORTED_CODENAMES.join(', ')}.`,
        )
      }

      // Same exec/echo shape as the panel self-update's apply step: stream
      // both streams as sink lines, fold the failing stderr tail into the
      // op error so the UI can show why.
      const run = async (step: string, bin: string, args: string[], timeout: number): Promise<void> => {
        try {
          const { stdout, stderr } = await execFileAsync(bin, args, {
            timeout,
            env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
            maxBuffer: 16 * 1024 * 1024,
          })
          for (const chunk of [stdout, stderr]) {
            for (const line of chunk.split('\n')) {
              if (line.trim()) sink.line(`[wine] ${line.trimEnd()}`)
            }
          }
        } catch (err) {
          const e = err as Error & { stdout?: string; stderr?: string; code?: number | string }
          for (const line of (e.stdout ?? '').split('\n')) {
            if (line.trim()) sink.line(`[wine] ${line.trimEnd()}`)
          }
          logger.error('wine update step failed', {
            step,
            code: e.code ?? null,
            stderr: e.stderr ?? '',
          })
          throw new Error(formatApplyFailure(step, e.code, e.stderr ?? ''))
        }
      }

      try {
        sink.line(`[wine] Adding the WineHQ repository for Debian ${codename}...`)
        sink.progress(5)
        await fs.promises.mkdir(KEYRING_DIR, { recursive: true })

        const download = async (url: string, dest: string): Promise<void> => {
          const res = await fetch(url, {
            headers: { 'user-agent': 'rallypoint-cmd-panel' },
            signal: AbortSignal.timeout(60_000),
            redirect: 'follow',
          })
          if (!res.ok) throw new Error(`Download of ${url} failed: HTTP ${res.status}`)
          const body = Buffer.from(await res.arrayBuffer())
          if (body.length === 0) throw new Error(`Download of ${url} returned an empty file.`)
          await fs.promises.writeFile(dest, body, { mode: 0o644 })
        }

        await download(WINEHQ_KEY_URL, KEYRING_PATH)
        sink.progress(15)
        await download(
          `https://dl.winehq.org/wine-builds/debian/dists/${codename}/winehq-${codename}.sources`,
          SOURCES_PATH,
        )
        sink.line('[wine] Repository added — refreshing package lists...')
        sink.progress(25)

        await run('apt-get update', '/usr/bin/apt-get', ['update'], 300_000)
        sink.line('[wine] Installing winehq-staging (esync/fsync)...')
        sink.progress(40)
        await run(
          'apt-get install winehq-staging',
          '/usr/bin/apt-get',
          ['install', '-y', '--install-recommends', 'winehq-staging'],
          900_000,
        )
        sink.progress(90)
      } catch (err) {
        // Leave apt in a working state for every later apt call — a
        // half-added WineHQ source breaks unrelated installs. The existing
        // Debian wine stays in place, so Windows servers keep starting.
        sink.line('[wine] Upgrade failed — rolling back the WineHQ repository.')
        await fs.promises.rm(SOURCES_PATH, { force: true }).catch(() => {})
        await execFileAsync('/usr/bin/apt-get', ['update'], {
          timeout: 300_000,
          env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        }).catch(() => {})
        sink.line('[wine] Rolled back — the previously installed Wine is still in use.')
        throw err
      }

      const after = await currentStatus()
      sink.line(
        after.installed
          ? `[wine] Now running ${after.version}${after.staging ? ' (staging — esync/fsync available)' : ' — staging was NOT detected'}.`
          : '[wine] Install reported success but no wine loader is on PATH.',
      )
      logger.info('wine upgraded', { version: after.version, staging: after.staging })
      sink.progress(100)
    },
  }
}

// Mock: starts on a vanilla Debian-ish wine and flips to staging once the
// fake op runs. Lets the whole UI flow run in PANEL_MODE=mock and in tests.
export function createFakeWineUpdate(_env?: Env): WineUpdateService {
  let staging = false
  const sleep = (ms: number) =>
    new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : ms))
  return {
    status() {
      return Promise.resolve({
        installed: true,
        version: staging ? 'wine-10.4 (Staging)' : 'wine-8.0',
        staging,
        upgradeSupported: true,
      })
    },
    async run(sink) {
      sink.line('[wine] Adding the WineHQ repository for Debian bookworm...')
      sink.progress(15)
      await sleep(300)
      sink.line('[wine] Repository added — refreshing package lists...')
      sink.progress(40)
      await sleep(300)
      sink.line('[wine] Installing winehq-staging (esync/fsync)...')
      await sleep(300)
      staging = true
      sink.line('[wine] Now running wine-10.4 (Staging) (staging — esync/fsync available).')
      sink.progress(100)
    },
  }
}
