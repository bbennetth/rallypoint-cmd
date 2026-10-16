import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import {
  WINE_BRANCHES,
  type WineBranch,
  type WineInstallRequest,
  type WineStatus,
  type WineVersionOption,
  type WineVersions,
} from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { OpSink } from './types.js'
import { formatApplyFailure } from './panel-update.js'

const execFileAsync = promisify(execFile)

// Panel-driven Wine manager: install WineHQ's stable, devel or staging
// build at a chosen version (or the newest one) from WineHQ's Debian repo.
//
// Windows-platform game servers (Enshrouded) run under Wine, and a new
// game build can need a newer Wine — or break on one — so the operator
// picks the build rather than the panel guessing. A specific version is
// apt-mark held so a routine `apt upgrade` doesn't silently move it;
// "latest" un-holds.
//
// The repo setup is the same work install/rallypoint-cmd-install.sh's
// install_winehq_staging() does at CT creation; this service lets an
// already-created CT change it from the panel. The panel runs as root
// (rallypoint-cmd.service has no User=), so apt-get is callable directly.

const WINEHQ_KEY_URL = 'https://dl.winehq.org/wine-builds/winehq.key'
const KEYRING_DIR = '/etc/apt/keyrings'
const KEYRING_PATH = '/etc/apt/keyrings/winehq-archive.key'
const SOURCES_PATH = '/etc/apt/sources.list.d/winehq.sources'
const OS_RELEASE_PATH = '/etc/os-release'
const APT_GET = '/usr/bin/apt-get'
const APT_CACHE = '/usr/bin/apt-cache'
const APT_MARK = '/usr/bin/apt-mark'
const DPKG = '/usr/bin/dpkg'
const DPKG_QUERY = '/usr/bin/dpkg-query'
// The codenames WineHQ publishes a Debian repo for that we install onto.
const SUPPORTED_CODENAMES = ['bookworm', 'trixie']

export interface WineUpdateService {
  status(): Promise<WineStatus>
  // refresh = re-download the WineHQ package index first (a few seconds).
  versions(opts: { refresh: boolean }): Promise<WineVersions>
  run(sink: OpSink, req: WineInstallRequest): Promise<void>
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

// "11.16~bookworm-1" -> "11.16". Exported for unit tests.
export function wineVersionLabel(aptVersion: string): string {
  return aptVersion.replace(/~.*$/, '')
}

function emptyBranches(): WineVersions['branches'] {
  return { stable: [], devel: [], staging: [] }
}

// `apt-cache madison winehq-stable winehq-devel winehq-staging` lines:
//   "winehq-staging | 11.16~bookworm-1 | https://dl.winehq.org/... Packages"
// madison lists each package's versions newest first; duplicates (the same
// version from several indexes) are dropped. Exported for unit tests.
export function parseMadison(stdout: string): WineVersions['branches'] {
  const out = emptyBranches()
  for (const line of stdout.split('\n')) {
    const cols = line.split('|').map((c) => c.trim())
    if (cols.length < 2) continue
    const m = cols[0]!.match(/^winehq-(stable|devel|staging)$/)
    if (!m) continue
    const branch = m[1] as WineBranch
    const aptVersion = cols[1]!
    if (!/^[0-9][0-9A-Za-z.+~-]*$/.test(aptVersion)) continue
    if (out[branch].some((o) => o.aptVersion === aptVersion)) continue
    out[branch].push({ aptVersion, label: wineVersionLabel(aptVersion) })
  }
  return out
}

// `dpkg-query -W -f '${Package}\t${Version}\t${db:Status-Abbrev}\n' ...`:
// the first fully installed ("ii") winehq-<branch>. Exported for tests.
export function parseInstalledBranch(stdout: string): { branch: WineBranch; aptVersion: string } | null {
  for (const line of stdout.split('\n')) {
    const [pkg, version, status] = line.split('\t').map((c) => c.trim())
    const m = pkg?.match(/^winehq-(stable|devel|staging)$/)
    if (!m || !version || !status?.startsWith('ii')) continue
    return { branch: m[1] as WineBranch, aptVersion: version }
  }
  return null
}

// The packages that make up one branch at one version. winehq-<b> is the
// /usr/bin shim, wine-<b> the common bits, and the -amd64/-i386 halves
// the loaders; all four share a version, and pinning only the top one lets
// apt pair it with a mismatched newer dependency. The i386 half only when
// the CT has i386 multiarch enabled. Exported for unit tests.
export function branchPackages(branch: WineBranch, i386: boolean): string[] {
  const pkgs = [`winehq-${branch}`, `wine-${branch}`, `wine-${branch}-amd64`]
  if (i386) pkgs.push(`wine-${branch}-i386`)
  return pkgs
}

interface Deps {
  env: Env
  logger: Logger
}

export function createRealWineUpdate(deps: Deps): WineUpdateService {
  const { logger } = deps
  const aptEnv = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }

  function osRelease(): string {
    try {
      return fs.readFileSync(OS_RELEASE_PATH, 'utf8')
    } catch {
      return ''
    }
  }

  // stdout even when the command exits non-zero (dpkg-query does for any
  // package it has never heard of, while still printing the ones it has).
  async function capture(bin: string, args: string[], timeout = 30_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout, env: aptEnv, maxBuffer: 8 * 1024 * 1024 })
      return stdout
    } catch (err) {
      return (err as { stdout?: string }).stdout ?? ''
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

  async function installedBranch(): Promise<{ branch: WineBranch; aptVersion: string } | null> {
    const out = await capture(DPKG_QUERY, [
      '-W',
      '-f',
      '${Package}\t${Version}\t${db:Status-Abbrev}\n',
      ...WINE_BRANCHES.map((b) => `winehq-${b}`),
    ])
    return parseInstalledBranch(out)
  }

  async function heldPackages(): Promise<string[]> {
    const out = await capture(APT_MARK, ['showhold'])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(winehq|wine)-(stable|devel|staging)(-amd64|-i386)?$/.test(l))
  }

  async function currentStatus(): Promise<WineStatus> {
    const [{ version, staging }, inst, held] = await Promise.all([probeWine(), installedBranch(), heldPackages()])
    return {
      installed: version !== null,
      version,
      staging,
      branch: inst?.branch ?? null,
      aptVersion: inst?.aptVersion ?? null,
      held: inst !== null && held.includes(`winehq-${inst.branch}`),
      upgradeSupported: codenameSupported(osRelease()),
    }
  }

  async function available(): Promise<WineVersions['branches']> {
    return parseMadison(await capture(APT_CACHE, ['madison', ...WINE_BRANCHES.map((b) => `winehq-${b}`)]))
  }

  // Refresh only the WineHQ index — a full `apt-get update` would hit
  // every Debian mirror for a dropdown.
  async function refreshWinehqIndex(): Promise<void> {
    await execFileAsync(
      APT_GET,
      [
        'update',
        '-o',
        `Dir::Etc::sourcelist=${SOURCES_PATH}`,
        '-o',
        'Dir::Etc::sourceparts=-',
        '-o',
        'APT::Get::List-Cleanup=0',
      ],
      { timeout: 120_000, env: aptEnv },
    )
  }

  return {
    status: currentStatus,

    async versions({ refresh }) {
      const repoConfigured = fs.existsSync(SOURCES_PATH)
      if (!repoConfigured) return { repoConfigured, branches: emptyBranches() }
      if (refresh) await refreshWinehqIndex()
      return { repoConfigured, branches: await available() }
    },

    async run(sink, req): Promise<void> {
      const codename = readCodename(osRelease())
      if (codename === null || !SUPPORTED_CODENAMES.includes(codename)) {
        throw new Error(
          `WineHQ builds are not supported on this system (Debian codename ${codename ?? 'unknown'}). ` +
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
            env: aptEnv,
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
          logger.error('wine install step failed', {
            step,
            code: e.code ?? null,
            stderr: e.stderr ?? '',
          })
          throw new Error(formatApplyFailure(step, e.code, e.stderr ?? ''))
        }
      }

      // Only a repo this run added is rolled back on failure; one that was
      // already there is what the installed Wine came from.
      const addedRepo = !fs.existsSync(SOURCES_PATH)
      try {
        if (addedRepo) {
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
        }
        sink.line('[wine] Refreshing package lists...')
        sink.progress(25)
        await run('apt-get update', APT_GET, ['update'], 300_000)

        // Resolve the request against what the repo actually offers, so a
        // stale dropdown can't send apt a version that doesn't exist.
        const offered = (await available())[req.branch]
        if (offered.length === 0) {
          throw new Error(`The WineHQ repository offers no ${req.branch} builds for Debian ${codename}.`)
        }
        const target = req.version ?? offered[0]!.aptVersion
        if (!offered.some((o) => o.aptVersion === target)) {
          throw new Error(
            `Wine ${req.branch} ${wineVersionLabel(target)} is not offered by the WineHQ repository ` +
              `(newest is ${offered[0]!.label}). Refresh the version list and pick again.`,
          )
        }

        const foreign = await capture(DPKG, ['--print-foreign-architectures'])
        const i386 = foreign.split('\n').some((l) => l.trim() === 'i386')
        const pkgs = branchPackages(req.branch, i386)

        // Holds from an earlier pinned install would block both this
        // install and apt removing another branch's conflicting shim.
        const held = await heldPackages()
        if (held.length > 0) await run('apt-mark unhold', APT_MARK, ['unhold', ...held], 60_000)

        sink.line(`[wine] Installing Wine ${req.branch} ${wineVersionLabel(target)}...`)
        sink.progress(40)
        await run(
          `apt-get install winehq-${req.branch}`,
          APT_GET,
          [
            'install',
            '-y',
            '--install-recommends',
            '--allow-downgrades',
            ...pkgs.map((p) => `${p}=${target}`),
          ],
          900_000,
        )
        sink.progress(90)

        if (req.version !== null) {
          await run('apt-mark hold', APT_MARK, ['hold', ...pkgs], 60_000)
          sink.line('[wine] Pinned — routine apt upgrades will leave this version alone.')
        }
      } catch (err) {
        // Leave apt in a working state for every later apt call — a
        // half-added WineHQ source breaks unrelated installs. Whatever Wine
        // was installed before stays in place, so Windows servers keep
        // starting.
        if (addedRepo) {
          sink.line('[wine] Install failed — rolling back the WineHQ repository.')
          await fs.promises.rm(SOURCES_PATH, { force: true }).catch(() => {})
          await execFileAsync(APT_GET, ['update'], { timeout: 300_000, env: aptEnv }).catch(() => {})
        }
        sink.line('[wine] The previously installed Wine is still in use.')
        throw err
      }

      const after = await currentStatus()
      sink.line(
        after.installed
          ? `[wine] Now running ${after.version}${after.held ? ' (pinned)' : ''}.`
          : '[wine] Install reported success but no wine loader is on PATH.',
      )
      logger.info('wine installed', { branch: after.branch, aptVersion: after.aptVersion, held: after.held })
      sink.progress(100)
    },
  }
}

// Mock: starts on a vanilla Debian-ish wine with a small fake WineHQ
// catalogue; the op installs whatever was asked. Lets the whole UI flow run
// in PANEL_MODE=mock and in tests.
export function createFakeWineUpdate(_env?: Env): WineUpdateService {
  const catalogue: WineVersions['branches'] = {
    stable: ['10.0.0.0~bookworm-1', '9.0.0.0~bookworm-1'].map(opt),
    devel: ['11.16~bookworm-1', '11.15~bookworm-1'].map(opt),
    staging: ['11.16~bookworm-1', '11.15~bookworm-1', '10.20~bookworm-1'].map(opt),
  }
  function opt(aptVersion: string): WineVersionOption {
    return { aptVersion, label: wineVersionLabel(aptVersion) }
  }
  let installed: { branch: WineBranch; aptVersion: string; held: boolean } | null = null
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : ms))
  return {
    status() {
      const label = installed ? wineVersionLabel(installed.aptVersion) : null
      return Promise.resolve({
        installed: true,
        version: installed
          ? `wine-${label}${installed.branch === 'staging' ? ' (Staging)' : ''}`
          : 'wine-8.0',
        staging: installed?.branch === 'staging',
        branch: installed?.branch ?? null,
        aptVersion: installed?.aptVersion ?? null,
        held: installed?.held ?? false,
        upgradeSupported: true,
      })
    },
    versions() {
      return Promise.resolve({ repoConfigured: true, branches: catalogue })
    },
    async run(sink, req) {
      const offered = catalogue[req.branch]
      const target = req.version ?? offered[0]!.aptVersion
      if (!offered.some((o) => o.aptVersion === target)) {
        throw new Error(`Wine ${req.branch} ${wineVersionLabel(target)} is not offered by the WineHQ repository.`)
      }
      sink.line('[wine] Refreshing package lists...')
      sink.progress(25)
      await sleep(300)
      sink.line(`[wine] Installing Wine ${req.branch} ${wineVersionLabel(target)}...`)
      sink.progress(60)
      await sleep(300)
      installed = { branch: req.branch, aptVersion: target, held: req.version !== null }
      sink.line(`[wine] Now running wine-${wineVersionLabel(target)}${installed.held ? ' (pinned)' : ''}.`)
      sink.progress(100)
    },
  }
}
