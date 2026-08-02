import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { unzipSync } from 'fflate'
import { ulid } from 'ulid'
import type { Mod } from '@rallypoint-cmd/shared'
import { SAFE_MOD_FILENAME } from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import { PAL_MODS_DIR, PAL_MODS_DISABLED_DIR } from './constants.js'
import { assertDiskFloor } from './disk.js'

// .pak mod manager. The filesystem is the source of truth: a mod is a
// pak in ~mods (enabled) or ~mods-disabled (disabled) plus any same-stem
// UE5 sidecars (.ucas/.utoc/.sig) that travel with it as a group.
// Uploads are staged under DATA_DIR/staging with a byte cap, and zip
// entries are flattened to their basename — zip-slip is impossible by
// construction. Extension allowlist only: the .pak magic lives in the
// file footer, so verifying it would mean parsing the whole pak.

const MAX_ZIP_ENTRIES = 10_000

export class ModError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_filename'
      | 'invalid_archive'
      | 'no_paks'
      | 'too_large'
      | 'not_found'
      | 'already_exists' = 'invalid_archive',
  ) {
    super(message)
    this.name = 'ModError'
  }
}

export interface ModsService {
  list(): Mod[]
  installFromUpload(
    body: ReadableStream<Uint8Array>,
    uploadFilename: string,
  ): Promise<{ installed: string[] }>
  setEnabled(id: string, enabled: boolean): void
  delete(id: string): void
}

// "MyMod_P.pak" → "MyMod_P". Only ever called on names that already
// matched SAFE_MOD_FILENAME, so the extension is always present.
export function modStem(filename: string): string {
  return filename.slice(0, filename.lastIndexOf('.'))
}

interface ScannedFile {
  name: string
  sizeBytes: number
  mtimeMs: number
  enabled: boolean
}

// Group scanned dir entries into Mod records. Only stems that have a
// .pak count as mods; stray sidecars without one are ignored. A pak
// present in BOTH dirs reads as enabled (the active dir wins).
export function groupMods(files: ScannedFile[]): Mod[] {
  const byStem = new Map<string, ScannedFile[]>()
  for (const f of files) {
    const stem = modStem(f.name)
    const group = byStem.get(stem)
    if (group) group.push(f)
    else byStem.set(stem, [f])
  }
  const mods: Mod[] = []
  for (const [stem, group] of byStem) {
    const paks = group.filter((f) => f.name.endsWith('.pak'))
    if (paks.length === 0) continue
    const enabled = paks.some((f) => f.enabled)
    // Files that live on the pak's side of the enabled/disabled split;
    // a stray duplicate on the other side is not part of this mod.
    const files = group.filter((f) => f.enabled === enabled)
    mods.push({
      id: stem,
      pakFilename: paks[0]!.name,
      files: files.map((f) => ({ filename: f.name, sizeBytes: f.sizeBytes })),
      sizeBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
      modifiedAtMs: Math.round(Math.max(...files.map((f) => f.mtimeMs))),
      enabled,
    })
  }
  return mods.sort((a, b) => a.id.localeCompare(b.id))
}

export function createModsService(env: Env, logger: Logger): ModsService {
  const modsDir = path.join(env.PAL_DIR, PAL_MODS_DIR)
  const disabledDir = path.join(env.PAL_DIR, PAL_MODS_DISABLED_DIR)
  const stagingRoot = path.join(env.DATA_DIR, 'staging')

  // Names come ONLY from readdir — never from user input.
  function scanDir(dir: string, enabled: boolean): ScannedFile[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return [] // dir not created yet
    }
    const out: ScannedFile[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !SAFE_MOD_FILENAME.test(entry.name)) continue
      try {
        const stat = fs.statSync(path.join(dir, entry.name))
        out.push({ name: entry.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, enabled })
      } catch {
        // vanished between readdir and stat — skip
      }
    }
    return out
  }

  function scanAll(): ScannedFile[] {
    const enabled = scanDir(modsDir, true)
    const disabled = scanDir(disabledDir, false)
    const enabledPaks = new Set(enabled.filter((f) => f.name.endsWith('.pak')).map((f) => f.name))
    for (const f of disabled) {
      if (enabledPaks.has(f.name)) {
        logger.warn('mod pak present in both ~mods and ~mods-disabled', { pak: f.name })
      }
    }
    return [...enabled, ...disabled]
  }

  // Staging (DATA_DIR) and PAL_DIR can be different filesystems in a
  // live deploy — fall back to copy+unlink on EXDEV.
  function moveFile(src: string, dest: string): void {
    try {
      fs.renameSync(src, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      fs.copyFileSync(src, dest)
      fs.rmSync(src, { force: true })
    }
  }

  function existingFilenames(): Set<string> {
    return new Set(scanAll().map((f) => f.name))
  }

  return {
    list(): Mod[] {
      return groupMods(scanAll())
    },

    async installFromUpload(body, uploadFilename) {
      const isZip = /\.zip$/i.test(uploadFilename)
      if (!isZip && !SAFE_MOD_FILENAME.test(uploadFilename)) {
        throw new ModError(
          'Upload must be a .pak (or a .zip containing paks) with a plain filename.',
          'invalid_filename',
        )
      }
      if (!isZip && !uploadFilename.endsWith('.pak')) {
        throw new ModError('Only .pak files (or .zip archives) can be installed.', 'invalid_filename')
      }

      // Refuse outright when disk is already at the floor; the projected
      // sizes are re-checked below once the upload's real size is known.
      await assertDiskFloor(env.PAL_DIR, 0, env.DISK_FLOOR_BYTES)

      const stageDir = path.join(stagingRoot, `mod-${ulid()}`)
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 })
      const uploadPath = path.join(stageDir, 'upload.bin')
      try {
        // Raw streamed write with a hard byte cap (same pattern as the
        // backup upload).
        let received = 0
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length
            if (received > env.MAX_UPLOAD_BYTES) {
              cb(new ModError(`Upload exceeds ${env.MAX_UPLOAD_BYTES} bytes.`, 'too_large'))
              return
            }
            cb(null, chunk)
          },
        })
        try {
          await pipeline(Readable.fromWeb(body), counter, fs.createWriteStream(uploadPath))
        } catch (err) {
          if (err instanceof ModError) throw err
          throw new ModError(
            `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_archive',
          )
        }

        // Collect { finalName → staged file } to install, then move as a
        // second phase so a mid-extract failure installs nothing.
        const staged = new Map<string, string>()
        if (isZip) {
          let totalUncompressed = 0
          let entriesSeen = 0
          let entries: Record<string, Uint8Array>
          try {
            entries = unzipSync(fs.readFileSync(uploadPath), {
              filter: (info) => {
                if (++entriesSeen > MAX_ZIP_ENTRIES) {
                  throw new ModError(`Archive has more than ${MAX_ZIP_ENTRIES} entries.`, 'invalid_archive')
                }
                // Flatten to basename; accept only mod-shaped files.
                // Skips dirs, __MACOSX/._* junk, and anything else.
                const base = path.basename(info.name.replace(/\\/g, '/'))
                if (!SAFE_MOD_FILENAME.test(base)) return false
                totalUncompressed += info.originalSize
                if (totalUncompressed > env.MAX_UNCOMPRESSED_BYTES) {
                  throw new ModError('Archive expands beyond the size cap.', 'too_large')
                }
                return true
              },
            })
          } catch (err) {
            if (err instanceof ModError) throw err
            throw new ModError(
              `Not a valid zip archive: ${err instanceof Error ? err.message : String(err)}`,
              'invalid_archive',
            )
          }
          for (const [entryName, data] of Object.entries(entries)) {
            const base = path.basename(entryName.replace(/\\/g, '/'))
            if (staged.has(base)) {
              throw new ModError(
                `Archive contains two entries that flatten to the same name: ${base}`,
                'invalid_archive',
              )
            }
            const stagedPath = path.join(stageDir, base)
            fs.writeFileSync(stagedPath, data)
            staged.set(base, stagedPath)
          }
          if (![...staged.keys()].some((n) => n.endsWith('.pak'))) {
            throw new ModError('Archive contains no .pak files.', 'no_paks')
          }
          await assertDiskFloor(env.PAL_DIR, totalUncompressed, env.DISK_FLOOR_BYTES)
        } else {
          staged.set(uploadFilename, uploadPath)
          await assertDiskFloor(env.PAL_DIR, received, env.DISK_FLOOR_BYTES)
        }

        // No silent overwrite — a name collision (either dir) is a 409.
        const existing = existingFilenames()
        for (const name of staged.keys()) {
          if (existing.has(name)) {
            throw new ModError(
              `A mod file named ${name} is already installed — delete it first.`,
              'already_exists',
            )
          }
        }

        fs.mkdirSync(modsDir, { recursive: true })
        for (const [name, stagedPath] of staged) {
          moveFile(stagedPath, path.join(modsDir, name))
        }
        const installed = [...staged.keys()].filter((n) => n.endsWith('.pak')).map(modStem)
        logger.info('mods installed', { installed, from: uploadFilename })
        return { installed }
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true })
      }
    },

    setEnabled(id, enabled) {
      const mod = groupMods(scanAll()).find((m) => m.id === id)
      if (!mod) throw new ModError('Mod not found.', 'not_found')
      if (mod.enabled === enabled) return
      const [srcDir, destDir] = enabled ? [disabledDir, modsDir] : [modsDir, disabledDir]
      fs.mkdirSync(destDir, { recursive: true })
      // Filenames come from the fresh scan (dirent names), never from id.
      for (const f of mod.files) {
        fs.renameSync(path.join(srcDir, f.filename), path.join(destDir, f.filename))
      }
      logger.info('mod toggled', { id, enabled })
    },

    delete(id) {
      const mod = groupMods(scanAll()).find((m) => m.id === id)
      if (!mod) throw new ModError('Mod not found.', 'not_found')
      const dir = mod.enabled ? modsDir : disabledDir
      for (const f of mod.files) {
        fs.rmSync(path.join(dir, f.filename), { force: true })
      }
      logger.info('mod deleted', { id })
    },
  }
}
