import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import * as tar from 'tar'
import { ulid } from 'ulid'
import { desc, eq } from 'drizzle-orm'
import type { Backup, BackupKind, BackupManifest, RestorePreview } from '@rallypoint-cmd/shared'
import { backupManifestSchema } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import { backups } from '../db/schema/index.js'
import type { GameControl, OpSink, PalRest, SteamCmd } from './types.js'
import type { SettingsService } from './settings-ini.js'
import { PAL_GAME_USER_SETTINGS_INI, PAL_SAVE_ROOT, PAL_SETTINGS_INI } from './constants.js'
import { assertDiskFloor } from './disk.js'
import { resolveWorldId, saveDirFor } from './world.js'

// Backup + restore engine — the panel's highest-risk surface. Every
// guardrail here is deliberate:
//  * create: REST save → COPY the live save dir → tar the copy → atomic
//    rename into BACKUP_DIR → DB row (paths only ever come from rows).
//  * upload: raw stream with a byte cap into an isolated staging dir.
//  * validate: dry-run listing pass (type allowlist, zip-slip, bomb
//    caps, shape check) BEFORE any extraction; extraction re-applies the
//    same filter.
//  * restore: stop game → rename live saves aside (rollback) → rename
//    staged saves in → restart → verify; ANY failure rolls back.

const HEX32 = /^[0-9A-Fa-f]{32}$/
const MAX_ENTRIES = 20_000
// Palworld's own rotating in-save backups (bIsUseBackupSaveData=True).
// Not world state: excluded from our archives, and the main reason a
// naive recursive copy of a LIVE save dir crashes (files vanish mid-copy).
export const PAL_INTERNAL_BACKUP_DIRS = ['backup'] as const

// Pure, directly-unit-tested path guard: reject absolute paths and any
// `..` component (zip-slip). Used by both the validation pass and the
// extract filter. tar entry paths always use forward slashes.
export function isSafeEntryPath(entryPath: string): boolean {
  const norm = entryPath.replace(/\\/g, '/')
  if (norm.startsWith('/')) return false
  if (norm.split('/').some((seg) => seg === '..')) return false
  return true
}

// Which part of our archive contract an entry satisfies (or 'unknown',
// which is rejected). Exported for direct unit testing.
export function classifyEntry(
  entryPath: string,
): { kind: 'manifest' | 'settings' | 'dir' } | { kind: 'save'; worldId: string } | { kind: 'unknown' } {
  const clean = entryPath.replace(/\\/g, '/').replace(/\/$/, '')
  if (clean === 'manifest.json') return { kind: 'manifest' }
  if (clean === 'PalWorldSettings.ini' || clean === 'GameUserSettings.ini') return { kind: 'settings' }
  if (clean === 'SaveGames' || clean === 'SaveGames/0') return { kind: 'dir' }
  const m = clean.match(/^SaveGames\/0\/([^/]+)(\/|$)/)
  if (m) return { kind: 'save', worldId: m[1]! }
  return { kind: 'unknown' }
}

// Validate the full entry list from a staged archive. Throws BackupError
// on the first violation; returns the discovered world id set on success.
export function validateArchiveEntries(
  entries: { path: string; type: string; size: number }[],
  caps: { maxEntries: number; maxUncompressed: number },
): { saveWorldIds: Set<string> } {
  if (entries.length > caps.maxEntries) {
    throw new BackupError(`Archive has more than ${caps.maxEntries} entries.`, 'archive_invalid')
  }
  let totalUncompressed = 0
  let sawManifest = false
  const saveWorldIds = new Set<string>()
  for (const entry of entries) {
    totalUncompressed += entry.size
    if (totalUncompressed > caps.maxUncompressed) {
      throw new BackupError('Archive expands beyond the size cap.', 'too_large')
    }
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new BackupError(
        `Archive contains a ${entry.type} entry — only files allowed.`,
        'archive_invalid',
      )
    }
    if (!isSafeEntryPath(entry.path)) {
      throw new BackupError('Archive contains an unsafe path.', 'archive_invalid')
    }
    const c = classifyEntry(entry.path)
    if (c.kind === 'manifest') sawManifest = true
    else if (c.kind === 'save') {
      if (!HEX32.test(c.worldId)) {
        throw new BackupError(`Unexpected world dir in archive: ${c.worldId}`, 'archive_invalid')
      }
      saveWorldIds.add(c.worldId)
    } else if (c.kind === 'unknown') {
      throw new BackupError(`Unexpected entry in archive: ${entry.path}`, 'archive_invalid')
    }
  }
  if (!sawManifest) throw new BackupError('Archive is missing manifest.json.', 'archive_invalid')
  if (saveWorldIds.size !== 1) {
    throw new BackupError('Archive must contain exactly one world save.', 'archive_invalid')
  }
  return { saveWorldIds }
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no_world'
      | 'not_installed'
      | 'archive_invalid'
      | 'too_large'
      | 'staging_missing'
      | 'confirm_mismatch'
      | 'restore_failed'
      | 'not_found' = 'archive_invalid',
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export interface BackupService {
  create(kind: BackupKind, sink?: OpSink): Promise<Backup>
  list(): Backup[]
  filePathFor(id: string): { filePath: string; filename: string; sizeBytes: number }
  delete(id: string): void
  stageUpload(body: ReadableStream<Uint8Array>): Promise<RestorePreview>
  restore(stagingId: string, confirm: string, sink: OpSink): Promise<void>
  pruneStaging(): void
}

interface BackupDeps {
  env: Env
  db: Db
  logger: Logger
  gameControl: GameControl
  palRest: PalRest
  steamcmd: SteamCmd
  settings: SettingsService
}

// Walk a directory tree, tolerating live-server churn (vanished dirs and
// files are skipped, not fatal). `excludeTopDirs` prunes top-level dirs —
// used to keep Palworld's rotating `backup/` out of our archives.
// Module-scope + exported for direct unit testing.
export function walkFiles(
  root: string,
  prefix = '',
  excludeTopDirs: readonly string[] = [],
): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out // dir vanished mid-walk (live server churn)
  }
  for (const entry of entries) {
    if (prefix === '' && entry.isDirectory() && excludeTopDirs.includes(entry.name)) continue
    const abs = path.join(root, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel))
    else if (entry.isFile()) {
      try {
        out.push({ rel, abs, size: fs.statSync(abs).size })
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  return out
}

// Copy a live save tree file-by-file, tolerating churn: a running
// Palworld server rotates files (esp. its own `backup/` zips, which we
// exclude entirely — they're the game's internal backups, not world
// state). fs.cpSync(recursive) aborts on the first ENOENT; this walks
// and skips vanished files instead. Exported for direct unit testing.
export function copySaveTree(
  srcRoot: string,
  destRoot: string,
  onProgress?: (copiedBytes: number, totalBytes: number) => void,
): { copiedBytes: number; skipped: string[] } {
  const files = walkFiles(srcRoot, '', PAL_INTERNAL_BACKUP_DIRS)
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  let copiedBytes = 0
  const skipped: string[] = []
  for (const f of files) {
    const dest = path.join(destRoot, f.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.copyFileSync(f.abs, dest)
      copiedBytes += f.size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push(f.rel) // vanished mid-copy; world state files don't do this, churn files do
      } else {
        throw err
      }
    }
    onProgress?.(copiedBytes, totalBytes)
  }
  return { copiedBytes, skipped }
}

export function createBackupService(deps: BackupDeps): BackupService {
  const { env, db, logger } = deps
  const stagingRoot = path.join(env.DATA_DIR, 'staging')
  const rollbackRoot = path.join(env.DATA_DIR, 'rollback')

  function rowToBackup(row: typeof backups.$inferSelect): Backup {
    return {
      id: row.id,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      worldId: row.worldId,
      buildId: row.buildId,
      kind: row.kind,
      createdAtMs: row.createdAt.getTime(),
    }
  }

  async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    await pipeline(fs.createReadStream(filePath), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer)
        yield
      }
    })
    return hash.digest('hex')
  }

  return {
    async create(kind, sink): Promise<Backup> {
      const say = (line: string): void => sink?.line(line)
      const pct = (n: number): void => sink?.progress(n)
      const worldId = resolveWorldId(env.PAL_DIR)
      if (!worldId) throw new BackupError('No world found to back up.', 'no_world')
      const saveDir = saveDirFor(env.PAL_DIR, worldId)

      // Disk floor: project roughly the save dir size (compressed will be
      // smaller; copy + archive both live on disk briefly). Excludes the
      // game's internal backup/ dir — we don't archive it.
      const saveFiles = walkFiles(saveDir, '', PAL_INTERNAL_BACKUP_DIRS)
      const saveBytes = saveFiles.reduce((a, f) => a + f.size, 0)
      await assertDiskFloor(env.BACKUP_DIR, saveBytes * 2, env.DISK_FLOOR_BYTES)
      pct(2)

      // Best-effort flush; a cold backup (game down) is fine too.
      say('[backup] Requesting world save via REST...')
      try {
        await deps.palRest.save()
        // Palworld flushes asynchronously; give it a moment.
        await new Promise((r) => setTimeout(r, 2000))
      } catch {
        say('[backup] REST save unavailable (game down?) — taking a cold backup.')
      }

      const stageId = ulid()
      const stageDir = path.join(stagingRoot, `create-${stageId}`)
      const archiveRoot = path.join(stageDir, 'root')
      try {
        // 1. Copy-then-archive so a live server can't tear files mid-tar.
        // Churn-tolerant: skips the game's own backup/ dir and files that
        // vanish mid-copy instead of aborting (progress: 2 → 40).
        say('[backup] Copying save data...')
        const stagedSave = path.join(archiveRoot, 'SaveGames', '0', worldId)
        fs.mkdirSync(path.dirname(stagedSave), { recursive: true })
        const { skipped } = copySaveTree(saveDir, stagedSave, (done, total) => {
          if (total > 0) pct(2 + (done / total) * 38)
        })
        if (skipped.length > 0) {
          say(`[backup] Skipped ${skipped.length} file(s) that changed mid-copy (server is live).`)
        }
        for (const ini of [PAL_SETTINGS_INI, PAL_GAME_USER_SETTINGS_INI]) {
          const src = path.join(env.PAL_DIR, ini)
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(archiveRoot, path.basename(ini)))
        }
        pct(40)

        // 2. Manifest with per-file hashes (progress: 40 → 75).
        say('[backup] Hashing files + writing manifest...')
        const files = walkFiles(archiveRoot)
        const manifest: BackupManifest = {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          worldId,
          buildId: await deps.steamcmd.installedBuildId(),
          panelVersion: env.PANEL_VERSION,
          files: await (async () => {
            const out: BackupManifest['files'] = []
            const totalHashBytes = files.reduce((a, f) => a + f.size, 0) || 1
            let hashed = 0
            for (const f of files) {
              out.push({ path: f.rel, sizeBytes: f.size, sha256: await sha256File(f.abs) })
              hashed += f.size
              pct(40 + (hashed / totalHashBytes) * 35)
            }
            return out
          })(),
        }
        fs.writeFileSync(path.join(archiveRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
        pct(75)

        // 3. Tar to a temp file IN BACKUP_DIR (same fs) then atomic rename
        // (progress: 75 → 95 on completion; tar has no per-byte callback).
        const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z')
        const filename = `palworld-${worldId.slice(0, 8)}-${stamp}.tar.gz`
        fs.mkdirSync(env.BACKUP_DIR, { recursive: true })
        const tmpFile = path.join(env.BACKUP_DIR, `.tmp-${stageId}.tar.gz`)
        say('[backup] Compressing archive...')
        await tar.create(
          { gzip: true, cwd: archiveRoot, file: tmpFile, portable: true },
          fs.readdirSync(archiveRoot),
        )
        pct(95)
        const finalPath = path.join(env.BACKUP_DIR, filename)
        fs.renameSync(tmpFile, finalPath)

        const stat = fs.statSync(finalPath)
        const digest = await sha256File(finalPath)
        pct(100)
        const id = ulid()
        db.insert(backups)
          .values({
            id,
            filename,
            sizeBytes: stat.size,
            sha256: digest,
            worldId,
            buildId: manifest.buildId,
            kind,
          })
          .run()
        say(`[backup] Done: ${filename} (${(stat.size / 1024 ** 2).toFixed(1)} MiB)`)
        logger.info('backup created', { id, filename, kind, sizeBytes: stat.size })
        const row = db.select().from(backups).where(eq(backups.id, id)).get()
        if (!row) throw new BackupError('backup row vanished', 'restore_failed')
        return rowToBackup(row)
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true })
      }
    },

    list(): Backup[] {
      return db.select().from(backups).orderBy(desc(backups.createdAt)).all().map(rowToBackup)
    },

    filePathFor(id) {
      const row = db.select().from(backups).where(eq(backups.id, id)).get()
      if (!row) throw new BackupError('Backup not found.', 'not_found')
      // Path comes from the DB row only — never from user input.
      const filePath = path.join(env.BACKUP_DIR, row.filename)
      if (!fs.existsSync(filePath)) throw new BackupError('Backup file missing on disk.', 'not_found')
      return { filePath, filename: row.filename, sizeBytes: row.sizeBytes }
    },

    delete(id) {
      const row = db.select().from(backups).where(eq(backups.id, id)).get()
      if (!row) throw new BackupError('Backup not found.', 'not_found')
      const filePath = path.join(env.BACKUP_DIR, row.filename)
      fs.rmSync(filePath, { force: true })
      db.delete(backups).where(eq(backups.id, id)).run()
      logger.info('backup deleted', { id, filename: row.filename })
    },

    async stageUpload(body): Promise<RestorePreview> {
      const stagingId = ulid()
      const stageDir = path.join(stagingRoot, stagingId)
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 })
      const uploadPath = path.join(stageDir, 'upload.tar.gz')

      // 1. Raw streamed write with a hard byte cap.
      let received = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length
          if (received > env.MAX_UPLOAD_BYTES) {
            cb(new BackupError(`Upload exceeds ${env.MAX_UPLOAD_BYTES} bytes.`, 'too_large'))
            return
          }
          cb(null, chunk)
        },
      })
      try {
        const { Readable } = await import('node:stream')
        await pipeline(Readable.fromWeb(body), counter, fs.createWriteStream(uploadPath))
      } catch (err) {
        fs.rmSync(stageDir, { recursive: true, force: true })
        if (err instanceof BackupError) throw err
        throw new BackupError(
          `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
          'archive_invalid',
        )
      }

      // 2. Dry-run listing pass. CRITICAL: collect entries during the
      // tar walk but validate AFTER it resolves — throwing inside
      // node-tar's onReadEntry callback does not reject the list()
      // promise (it surfaces as an unhandled error and the stream hangs).
      const listed: { path: string; type: string; size: number }[] = []
      try {
        await tar.list({
          file: uploadPath,
          strict: true,
          onReadEntry: (entry) => {
            listed.push({ path: entry.path, type: String(entry.type), size: entry.size ?? 0 })
          },
        })
      } catch (err) {
        fs.rmSync(stageDir, { recursive: true, force: true })
        throw new BackupError(
          `Not a valid tar.gz archive: ${err instanceof Error ? err.message : String(err)}`,
          'archive_invalid',
        )
      }

      try {
        const { saveWorldIds } = validateArchiveEntries(listed, {
          maxEntries: MAX_ENTRIES,
          maxUncompressed: env.MAX_UNCOMPRESSED_BYTES,
        })
        const archiveWorldId = [...saveWorldIds][0]!

        // 3. Extract into staging. Safe: every entry already passed the
        // strict validation above, and node-tar strips traversal by
        // default; the filter is a stateless belt-and-suspenders.
        const extractDir = path.join(stageDir, 'extracted')
        fs.mkdirSync(extractDir)
        await tar.extract({
          file: uploadPath,
          cwd: extractDir,
          strict: true,
          filter: (p, entry) => {
            const type = 'type' in entry && entry.type ? String(entry.type) : 'File'
            return (type === 'File' || type === 'Directory') && isSafeEntryPath(p)
          },
        })

        // 4. Manifest ↔ content cross-check.
        const manifestRaw = fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')
        const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw))
        if (manifest.worldId.toLowerCase() !== archiveWorldId.toLowerCase()) {
          throw new BackupError('manifest.json worldId does not match the archived save dir.', 'archive_invalid')
        }
        if (!fs.existsSync(path.join(extractDir, 'SaveGames', '0', archiveWorldId, 'Level.sav'))) {
          throw new BackupError('Archive save dir has no Level.sav — not a Palworld world.', 'archive_invalid')
        }

        const currentWorldId = resolveWorldId(env.PAL_DIR)
        logger.info('restore staged', { stagingId, worldId: manifest.worldId })
        return {
          stagingId,
          manifest,
          currentWorldId,
          worldIdMismatch:
            currentWorldId !== null &&
            currentWorldId.toLowerCase() !== manifest.worldId.toLowerCase(),
        }
      } catch (err) {
        fs.rmSync(stageDir, { recursive: true, force: true })
        if (err instanceof BackupError) throw err
        throw new BackupError(
          `Archive validation failed: ${err instanceof Error ? err.message : String(err)}`,
          'archive_invalid',
        )
      }
    },

    async restore(stagingId, confirm, sink): Promise<void> {
      const say = (line: string): void => sink.line(line)
      const pct = (n: number): void => sink.progress(n)
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(stagingId)) {
        throw new BackupError('Invalid staging id.', 'staging_missing')
      }
      const stageDir = path.join(stagingRoot, stagingId)
      const extractDir = path.join(stageDir, 'extracted')
      if (!fs.existsSync(extractDir)) {
        throw new BackupError('Staged upload not found (expired?). Upload again.', 'staging_missing')
      }
      const manifest = backupManifestSchema.parse(
        JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')),
      )
      // Server-side confirmation — the UI asks the user to type the world
      // id (or "restore"); we never trust a bare button click.
      if (confirm.toLowerCase() !== manifest.worldId.toLowerCase() && confirm !== 'restore') {
        throw new BackupError('Confirmation text did not match.', 'confirm_mismatch')
      }

      const saveRoot = path.join(env.PAL_DIR, PAL_SAVE_ROOT)
      // Preflight: root-owned save dirs (e.g. from a manual `pct push`
      // import) make every fs op below fail with EACCES. Fail up front
      // with an actionable message instead of a bare errno.
      try {
        fs.mkdirSync(saveRoot, { recursive: true })
        fs.accessSync(saveRoot, fs.constants.W_OK)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          throw new BackupError(
            `The panel user cannot write ${saveRoot} (some files are probably root-owned from a manual copy). Fix inside the container with: chown -R palworld:palworld ${env.PAL_DIR}/Pal/Saved`,
            'restore_failed',
          )
        }
        throw err
      }
      const stagedWorldDir = ((): string => {
        const dirs = fs.readdirSync(path.join(extractDir, 'SaveGames', '0'))
        return path.join(extractDir, 'SaveGames', '0', dirs[0]!)
      })()
      const targetWorldId = path.basename(stagedWorldDir)
      const liveWorldDir = path.join(saveRoot, targetWorldId)

      const statusBefore = await deps.gameControl.status()
      const wasActive =
        statusBefore.activeState === 'active' || statusBefore.activeState === 'activating'

      // 1. Stop the game — never swap saves under a running server.
      pct(5)
      if (wasActive) {
        say('[restore] Stopping palworld.service...')
        await deps.gameControl.stop()
        const stopped = await deps.gameControl.waitFor('inactive', 120_000)
        if (!stopped) throw new BackupError('Game did not stop within 120s.', 'restore_failed')
      }
      pct(20)

      // 2. Snapshot current saves aside for rollback (atomic rename).
      const rollbackDir = path.join(rollbackRoot, ulid())
      fs.mkdirSync(rollbackDir, { recursive: true })
      const hadLiveWorld = fs.existsSync(liveWorldDir)
      const rollbackWorldDir = path.join(rollbackDir, targetWorldId)

      try {
        if (hadLiveWorld) {
          say(`[restore] Moving current world aside → ${path.basename(rollbackDir)}/`)
          fs.renameSync(liveWorldDir, rollbackWorldDir)
        }
        pct(35)

        // 3. Swap staged world in (rename — same fs? staging lives in
        // DATA_DIR which may be another fs; fall back to copy).
        say(`[restore] Installing world ${targetWorldId}...`)
        try {
          fs.renameSync(stagedWorldDir, liveWorldDir)
        } catch {
          fs.cpSync(stagedWorldDir, liveWorldDir, { recursive: true })
        }
        pct(55)

        // 4. Point DedicatedServerName at the restored world if it moved.
        const gusPath = path.join(env.PAL_DIR, PAL_GAME_USER_SETTINGS_INI)
        if (fs.existsSync(gusPath)) {
          const gus = fs.readFileSync(gusPath, 'utf8')
          const updated = gus.replace(
            /DedicatedServerName\s*=\s*[0-9A-Fa-f]{32}/,
            `DedicatedServerName=${targetWorldId.toLowerCase()}`,
          )
          if (updated !== gus) {
            say('[restore] Updating DedicatedServerName to match restored world.')
            fs.writeFileSync(gusPath, updated)
          }
        }

        // 4b. Import the archived server settings, if the backup carried
        // them. writeRaw round-trips through the tuple parser and
        // re-enforces the panel invariants (REST on + panel-managed
        // AdminPassword, RCON off) — an imported ini can never lock the
        // panel out of the game. Best-effort: a malformed ini shouldn't
        // sink an otherwise-good world restore.
        const archivedIni = path.join(extractDir, 'PalWorldSettings.ini')
        if (fs.existsSync(archivedIni)) {
          try {
            deps.settings.writeRaw(fs.readFileSync(archivedIni, 'utf8'))
            say('[restore] Imported server settings from the backup (panel-managed keys re-enforced).')
          } catch (err) {
            say(
              `[restore] Backup contained PalWorldSettings.ini but it failed to parse — keeping current settings (${err instanceof Error ? err.message : String(err)}).`,
            )
          }
        }
        pct(65)

        // 5. Restart + verify. The (re)start applies any imported ini, so
        // the pending-restart banner would be stale — clear it.
        pct(70)
        if (wasActive) {
          say('[restore] Starting palworld.service...')
          await deps.gameControl.start()
          const up = await deps.gameControl.waitFor('active', 180_000)
          if (!up) throw new BackupError('Game failed to come back up after restore.', 'restore_failed')
          deps.settings.clearPendingRestart()
        }
        pct(100)
        say('[restore] Restore complete.')
        logger.info('restore complete', { stagingId, worldId: targetWorldId })
        // Keep the rollback snapshot for manual recovery; prune later.
        fs.rmSync(stageDir, { recursive: true, force: true })
      } catch (err) {
        // Roll back: put the original world back and restart.
        say('[restore] FAILED — rolling back to the previous world...')
        logger.error('restore failed; rolling back', {
          stagingId,
          err: err instanceof Error ? err.message : String(err),
        })
        try {
          fs.rmSync(liveWorldDir, { recursive: true, force: true })
          if (hadLiveWorld) fs.renameSync(rollbackWorldDir, liveWorldDir)
          if (wasActive) {
            await deps.gameControl.start()
          }
          say('[restore] Rollback complete — previous world is back.')
        } catch (rollbackErr) {
          logger.error('rollback ALSO failed', {
            err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          })
          say('[restore] ROLLBACK FAILED — manual recovery needed (see rollback dir).')
        }
        throw err
      }
    },

    pruneStaging(): void {
      // Drop staging/rollback dirs older than 24h.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const root of [stagingRoot, rollbackRoot]) {
        if (!fs.existsSync(root)) continue
        for (const entry of fs.readdirSync(root)) {
          const p = path.join(root, entry)
          try {
            if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
          } catch {
            // ignore
          }
        }
      }
    },
  }
}
