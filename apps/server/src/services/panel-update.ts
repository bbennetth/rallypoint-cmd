import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { eq } from 'drizzle-orm'
import type { PanelUpdateInfo } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import { panelState } from '../db/schema/index.js'
import type { OpSink } from './types.js'
import { isSafeEntryPath } from './backup.js'

const execFileAsync = promisify(execFile)

// Panel self-update from GitHub Releases.
//
// Security shape: /opt/rallypoint-cmd is root:palworld READ-ONLY — the
// panel never writes its own code. It downloads + verifies the release
// artifact into DATA_DIR staging, then hands off to the pinned root
// helper (sudoers-whitelisted) which swaps files in and restarts the
// service. The restart kills this process mid-op BY DESIGN; the UI polls
// /api/health until the new version answers.

const GITHUB_REPO = 'bbennetth/rallypoint-cmd'
const CHECK_TTL_MS = 24 * 60 * 60 * 1000 // daily
const STATE_KEY = 'panel_update_check'
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024
const MAX_ARTIFACT_ENTRIES = 50_000
export const APPLY_HELPER = '/usr/local/bin/rallypoint-cmd-apply-update'

interface CachedCheck {
  latest: string | null
  publishedAt: string | null
  notes: string | null
  assetUrl: string | null
  assetBytes: number | null
  checkedAtMs: number
}

export interface PanelUpdateService {
  info(force: boolean): Promise<PanelUpdateInfo>
  run(sink: OpSink): Promise<void>
}

// Compare "v1.2.3"-ish semver-ish tags; true when latest is newer than
// current. Non-parsing strings compare unequal-string (dev builds always
// see releases as updates). Exported for unit tests.
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const c = parse(current)
  const l = parse(latest)
  if (!c || !l) return current.replace(/^v/, '') !== latest.replace(/^v/, '')
  for (let i = 0; i < 3; i++) {
    if (l[i]! > c[i]!) return true
    if (l[i]! < c[i]!) return false
  }
  return false
}

// The apply helper's stderr is the only place the real failure reason
// lives (sudoers denial, rsync/npm errors, visudo refusal). Fold its
// tail into the op error so the UI can show why. Exported for unit tests.
export function formatHelperFailure(code: number | string | undefined, stderr: string): string {
  const tail = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
  const head = `Apply helper failed${code != null ? ` (exit ${code})` : ''}`
  return tail.length > 0 ? `${head}: ${tail.join(' | ')}` : `${head} with no output.`
}

interface Deps {
  env: Env
  db: Db
  logger: Logger
}

export function createRealPanelUpdate(deps: Deps): PanelUpdateService {
  const { env, db, logger } = deps

  function readCache(): CachedCheck | null {
    const row = db.select().from(panelState).where(eq(panelState.key, STATE_KEY)).get()
    if (!row) return null
    try {
      return JSON.parse(row.value) as CachedCheck
    } catch {
      return null
    }
  }

  function writeCache(check: CachedCheck): void {
    db.insert(panelState)
      .values({ key: STATE_KEY, value: JSON.stringify(check), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: panelState.key,
        set: { value: JSON.stringify(check), updatedAt: new Date() },
      })
      .run()
  }

  async function fetchLatest(): Promise<CachedCheck> {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'rallypoint-cmd-panel' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) {
      // No releases published yet.
      return { latest: null, publishedAt: null, notes: null, assetUrl: null, assetBytes: null, checkedAtMs: Date.now() }
    }
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const json = (await res.json()) as {
      tag_name?: string
      published_at?: string
      body?: string
      assets?: { name: string; browser_download_url: string; size: number }[]
    }
    const asset = (json.assets ?? []).find((a) => /^rallypoint-cmd-.*\.tar\.gz$/.test(a.name))
    return {
      latest: json.tag_name ?? null,
      publishedAt: json.published_at ?? null,
      notes: json.body?.slice(0, 4000) ?? null,
      assetUrl: asset?.browser_download_url ?? null,
      assetBytes: asset?.size ?? null,
      checkedAtMs: Date.now(),
    }
  }

  async function getCheck(force: boolean): Promise<CachedCheck> {
    const cached = readCache()
    if (!force && cached && Date.now() - cached.checkedAtMs < CHECK_TTL_MS) return cached
    try {
      const fresh = await fetchLatest()
      writeCache(fresh)
      return fresh
    } catch (err) {
      logger.warn('panel update check failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      if (cached) return cached
      throw err
    }
  }

  return {
    async info(force): Promise<PanelUpdateInfo> {
      const check = await getCheck(force)
      return {
        current: env.PANEL_VERSION,
        latest: check.latest,
        updateAvailable:
          check.latest !== null &&
          check.assetUrl !== null &&
          isNewerVersion(env.PANEL_VERSION, check.latest),
        publishedAt: check.publishedAt,
        notes: check.notes,
        checkedAtMs: check.checkedAtMs,
      }
    },

    async run(sink): Promise<void> {
      const check = await getCheck(true)
      if (!check.latest || !check.assetUrl) throw new Error('No release available to update to.')
      if (!isNewerVersion(env.PANEL_VERSION, check.latest)) {
        throw new Error(`Already on ${env.PANEL_VERSION} (latest is ${check.latest}).`)
      }

      // 1. Download the artifact to staging with a byte cap.
      const stageRoot = path.join(env.DATA_DIR, 'panel-update')
      fs.rmSync(stageRoot, { recursive: true, force: true })
      fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
      const tarball = path.join(stageRoot, 'artifact.tar.gz')
      sink.line(`[update] Downloading ${check.latest} artifact...`)
      const res = await fetch(check.assetUrl, {
        headers: { 'user-agent': 'rallypoint-cmd-panel' },
        signal: AbortSignal.timeout(300_000),
        redirect: 'follow',
      })
      if (!res.ok || !res.body) throw new Error(`Artifact download failed: HTTP ${res.status}`)
      let received = 0
      const total = check.assetBytes ?? 0
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
        async function* (source) {
          for await (const chunk of source) {
            received += (chunk as Buffer).length
            if (received > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the size cap.')
            if (total > 0) sink.progress(Math.min(50, (received / total) * 50))
            yield chunk as Buffer
          }
        },
        fs.createWriteStream(tarball, { mode: 0o600 }),
      )
      sink.progress(50)

      // 2. Validate the tar (reuses the backup guards: no links/devices,
      // no traversal, entry cap) and check release.json matches.
      sink.line('[update] Validating artifact...')
      let entryCount = 0
      await tar.list({
        file: tarball,
        strict: true,
        onReadEntry: (entry) => {
          entryCount++
          if (entryCount > MAX_ARTIFACT_ENTRIES) throw new Error('Artifact has too many entries.')
          const type = String(entry.type)
          if (type !== 'File' && type !== 'Directory') {
            throw new Error(`Artifact contains a ${type} entry — only files allowed.`)
          }
          if (!isSafeEntryPath(entry.path)) throw new Error('Artifact contains an unsafe path.')
        },
      })
      const extractDir = path.join(stageRoot, 'extracted')
      fs.mkdirSync(extractDir)
      await tar.extract({ file: tarball, cwd: extractDir, strict: true })
      const releaseJsonPath = path.join(extractDir, 'release.json')
      if (!fs.existsSync(releaseJsonPath)) throw new Error('Artifact is missing release.json.')
      const release = JSON.parse(fs.readFileSync(releaseJsonPath, 'utf8')) as { version?: string }
      if (release.version !== check.latest) {
        throw new Error(
          `Artifact version ${release.version ?? '?'} does not match release ${check.latest}.`,
        )
      }
      for (const required of ['apps/server/dist/server.js', 'apps/web/dist/index.html', 'package-lock.json']) {
        if (!fs.existsSync(path.join(extractDir, required))) {
          throw new Error(`Artifact is missing ${required} — refusing to apply.`)
        }
      }
      sink.progress(70)

      // 3. Hand off to the pinned root helper. It swaps /opt/rallypoint-cmd,
      // installs prod deps, fixes ownership, and restarts the service —
      // which kills this process. Everything after this line may not run.
      sink.line(`[update] Applying ${check.latest} — the panel will restart momentarily...`)
      sink.progress(80)
      const emitHelperOutput = (stdout: string, stderr: string): void => {
        for (const chunk of [stdout, stderr]) {
          for (const line of chunk.split('\n')) {
            if (line.trim()) sink.line(`[helper] ${line.trimEnd()}`)
          }
        }
      }
      try {
        const { stdout, stderr } = await execFileAsync('sudo', ['-n', APPLY_HELPER, extractDir], {
          timeout: 600_000,
        })
        emitHelperOutput(stdout, stderr)
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: number | string }
        emitHelperOutput(e.stdout ?? '', e.stderr ?? '')
        logger.error('panel update apply failed', { code: e.code ?? null, stderr: e.stderr ?? '' })
        throw new Error(formatHelperFailure(e.code, e.stderr ?? ''))
      }
      // Only reached if the restart is slow to land:
      sink.line('[update] Helper finished; waiting for service restart.')
      sink.progress(95)
    },
  }
}

// Mock: pretends v9.9.9 is available and simulates an update that
// "restarts" (the op just completes). Lets the whole UI flow run in
// PANEL_MODE=mock and in tests.
export function createFakePanelUpdate(env: Env): PanelUpdateService {
  let checkedAtMs: number | null = null
  return {
    info(force) {
      if (force || checkedAtMs === null) checkedAtMs = Date.now()
      return Promise.resolve({
        current: env.PANEL_VERSION,
        latest: 'v9.9.9',
        updateAvailable: true,
        publishedAt: new Date().toISOString(),
        notes: 'Fake release for mock mode.\n- everything is better',
        checkedAtMs,
      })
    },
    async run(sink) {
      sink.line('[update] Downloading v9.9.9 artifact...')
      for (let p = 0; p <= 50; p += 10) {
        sink.progress(p)
        await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : 300))
      }
      sink.line('[update] Validating artifact...')
      sink.progress(70)
      sink.line('[update] Applying v9.9.9 — the panel will restart momentarily...')
      sink.progress(100)
    },
  }
}
