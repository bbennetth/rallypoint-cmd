import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { createDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import type { Env } from '../env.js'
import { buildLogger } from '../logger.js'
import { createFakeServices } from './fake/index.js'
import { createSettingsService } from './settings-ini.js'
import {
  classifyEntry,
  copySaveTree,
  createBackupService,
  isSafeEntryPath,
  validateArchiveEntries,
  walkFiles,
  type BackupService,
} from './backup.js'
import type { OpSink } from './types.js'
import { vi } from 'vitest'

// Adversarial coverage for the restore path — the highest data-loss
// surface. Each test crafts a malicious/malformed archive and asserts
// stageUpload rejects it BEFORE anything is applied.

const WORLD = '0123456789ABCDEF0123456789ABCDEF'
const noopSink: OpSink = { line: () => {}, progress: () => {} }

function makeEnv(root: string): Env {
  return {
    NODE_ENV: 'test',
    PANEL_MODE: 'mock',
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: 0,
    DATA_DIR: path.join(root, 'panel'),
    BACKUP_DIR: path.join(root, 'backups'),
    PAL_DIR: path.join(root, 'palworld'),
    STEAMCMD_BIN: path.join(root, 'steamcmd.sh'),
    DB_PATH: path.join(root, 'panel', 'panel.sqlite'),
    PAL_REST_URL: 'http://127.0.0.1:8212',
    PANEL_PASSWORD_PEPPER: 'test-pepper-0123456789abcdef',
    PANEL_PEPPER_VERSION: 1,
    PANEL_ADMIN_USERNAME: 'admin',
    PANEL_ADMIN_PASSWORD: 'test',
    SESSION_TTL_DAYS: 30,
    COOKIE_SECURE: false,
    SESSION_COOKIE_NAME: 'rp_session',
    CSRF_COOKIE_NAME: 'rp_csrf',
    TRUSTED_PROXY: false,
    DISK_FLOOR_BYTES: 0,
    MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
    MAX_UNCOMPRESSED_BYTES: 100 * 1024 * 1024,
    PANEL_VERSION: '0.1.0-test',
  }
}

function bodyOf(filePath: string): ReadableStream<Uint8Array> {
  const buf = fs.readFileSync(filePath)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf))
      controller.close()
    },
  })
}

let root: string
let env: Env
let service: BackupService
let closeDb: () => void

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-backup-test-'))
  env = makeEnv(root)
  const logger = buildLogger('error')
  const { db, sqlite } = createDb(env.DB_PATH)
  runMigrations(db)
  closeDb = () => sqlite.close()
  const fakes = createFakeServices(env, logger)
  // Install + boot the fake world so there's something to back up.
  await fakes.steamcmd.run('install', noopSink)
  await fakes.gameControl.start()
  service = createBackupService({
    env,
    db,
    logger,
    gameControl: fakes.gameControl,
    palRest: fakes.palRest,
    steamcmd: fakes.steamcmd,
    settings: createSettingsService(env, db),
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

// Helper: build an archive from a temp tree and return its path.
function buildArchive(files: Record<string, string>, addSymlink?: { at: string; to: string }): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-arc-src-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(src, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  if (addSymlink) {
    const abs = path.join(src, addSymlink.at)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.symlinkSync(addSymlink.to, abs)
  }
  const out = path.join(src, 'archive.tar.gz')
  tar.create({ gzip: true, cwd: src, file: out, portable: true, sync: true }, fs.readdirSync(src).filter((f) => f !== 'archive.tar.gz'))
  return out
}

function goodManifest(worldId = WORLD): string {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date('2026-07-19T00:00:00Z').toISOString(),
    worldId,
    buildId: '20260719',
    panelVersion: '0.1.0-test',
    files: [],
  })
}

describe('live-churn copy (the real-deploy backup fix)', () => {
  it('copySaveTree excludes the game-internal backup/ dir', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-churn-src-'))
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-churn-dst-'))
    fs.writeFileSync(path.join(src, 'Level.sav'), 'level')
    fs.mkdirSync(path.join(src, 'Players'))
    fs.writeFileSync(path.join(src, 'Players', 'p1.sav'), 'player')
    fs.mkdirSync(path.join(src, 'backup', 'world'), { recursive: true })
    fs.writeFileSync(path.join(src, 'backup', 'world', 'old.zip'), 'churny-zip')

    const res = copySaveTree(src, dst)
    expect(res.skipped).toEqual([])
    expect(fs.existsSync(path.join(dst, 'Level.sav'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'Players', 'p1.sav'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'backup'))).toBe(false)
    fs.rmSync(src, { recursive: true, force: true })
    fs.rmSync(dst, { recursive: true, force: true })
  })

  it('copySaveTree skips files that vanish mid-copy (ENOENT) instead of aborting', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-churn2-src-'))
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-churn2-dst-'))
    fs.writeFileSync(path.join(src, 'Level.sav'), 'level')
    fs.writeFileSync(path.join(src, 'vanishing.sav'), 'gone-soon')

    const realCopy = fs.copyFileSync.bind(fs)
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode?) => {
      if (String(from).endsWith('vanishing.sav')) {
        const err = new Error('ENOENT: vanished') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return realCopy(from, to, mode)
    })
    try {
      const res = copySaveTree(src, dst)
      expect(res.skipped).toEqual(['vanishing.sav'])
      expect(fs.existsSync(path.join(dst, 'Level.sav'))).toBe(true)
      expect(fs.existsSync(path.join(dst, 'vanishing.sav'))).toBe(false)
    } finally {
      spy.mockRestore()
      fs.rmSync(src, { recursive: true, force: true })
      fs.rmSync(dst, { recursive: true, force: true })
    }
  })

  it('walkFiles tolerates a directory vanishing entirely', () => {
    expect(walkFiles('/definitely/not/a/real/dir')).toEqual([])
  })

  it('create() succeeds with a churning backup/ dir present and excludes it from the archive', async () => {
    // Simulate the live server: game-internal rotating backups inside the save dir.
    const saveDir = path.join(env.PAL_DIR, 'Pal/Saved/SaveGames/0', WORLD)
    fs.mkdirSync(path.join(saveDir, 'backup', 'world'), { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'backup', 'world', 'rotating.zip'), 'x'.repeat(5000))

    const backup = await service.create('manual', noopSink)
    const listed: string[] = []
    await tar.list({
      file: path.join(env.BACKUP_DIR, backup.filename),
      onReadEntry: (e) => void listed.push(e.path),
    })
    expect(listed.some((p) => p.includes('/backup/'))).toBe(false)
    expect(listed.some((p) => p.endsWith('Level.sav'))).toBe(true)
  })

  it('create() reports monotonic progress up to 100', async () => {
    const pcts: number[] = []
    const sink: OpSink = { line: () => {}, progress: (n) => pcts.push(n) }
    await service.create('manual', sink)
    expect(pcts.length).toBeGreaterThan(2)
    expect(Math.max(...pcts)).toBe(100)
    const sorted = [...pcts].sort((a, b) => a - b)
    expect(pcts).toEqual(sorted) // never goes backwards
  })
})

describe('backup create + download', () => {
  it('creates a backup and records a row with a real file', async () => {
    const backup = await service.create('manual', noopSink)
    expect(backup.worldId).toBe(WORLD)
    expect(fs.existsSync(path.join(env.BACKUP_DIR, backup.filename))).toBe(true)
    expect(service.list()).toHaveLength(1)
    const resolved = service.filePathFor(backup.id)
    expect(resolved.sizeBytes).toBeGreaterThan(0)
  })

  it('round-trips: a created backup re-uploads and validates', async () => {
    const backup = await service.create('manual', noopSink)
    const preview = await service.stageUpload(bodyOf(path.join(env.BACKUP_DIR, backup.filename)))
    expect(preview.manifest.worldId).toBe(WORLD)
    expect(preview.worldIdMismatch).toBe(false)
  })
})

// Path-traversal is tested against the pure guard directly, because
// `tar.create` refuses to WRITE `..`/absolute entries — a real attacker
// archive is crafted by other tooling. These are the functions that
// stand between such an archive and the filesystem.
describe('path-safety guard (pure)', () => {
  it('rejects absolute and .. paths, accepts normal ones', () => {
    expect(isSafeEntryPath('SaveGames/0/abc/Level.sav')).toBe(true)
    expect(isSafeEntryPath('manifest.json')).toBe(true)
    expect(isSafeEntryPath('/etc/passwd')).toBe(false)
    expect(isSafeEntryPath('../escape.txt')).toBe(false)
    expect(isSafeEntryPath('SaveGames/0/../../etc/cron.d/x')).toBe(false)
    expect(isSafeEntryPath('a/../../b')).toBe(false)
  })

  it('classifies entries against the archive contract', () => {
    expect(classifyEntry('manifest.json').kind).toBe('manifest')
    expect(classifyEntry('PalWorldSettings.ini').kind).toBe('settings')
    expect(classifyEntry(`SaveGames/0/${WORLD}/Level.sav`)).toEqual({ kind: 'save', worldId: WORLD })
    expect(classifyEntry('evil.sh').kind).toBe('unknown')
  })

  it('validateArchiveEntries rejects a traversal entry and a bomb', () => {
    expect(() =>
      validateArchiveEntries(
        [
          { path: 'manifest.json', type: 'File', size: 10 },
          { path: '../../etc/passwd', type: 'File', size: 10 },
        ],
        { maxEntries: 100, maxUncompressed: 1000 },
      ),
    ).toThrowError(/unsafe path/)
    expect(() =>
      validateArchiveEntries(
        [
          { path: 'manifest.json', type: 'File', size: 10 },
          { path: `SaveGames/0/${WORLD}/Level.sav`, type: 'File', size: 10_000 },
        ],
        { maxEntries: 100, maxUncompressed: 500 },
      ),
    ).toThrowError(/size cap/)
  })
})

describe('restore guardrails (adversarial archives)', () => {
  it('rejects a symlink entry', async () => {
    const arc = buildArchive(
      { 'manifest.json': goodManifest(), [`SaveGames/0/${WORLD}/Level.sav`]: 'x' },
      { at: 'SaveGames/0/link', to: '/etc/passwd' },
    )
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects an archive missing manifest.json', async () => {
    const arc = buildArchive({ [`SaveGames/0/${WORLD}/Level.sav`]: 'x' })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects unexpected top-level entries', async () => {
    const arc = buildArchive({
      'manifest.json': goodManifest(),
      [`SaveGames/0/${WORLD}/Level.sav`]: 'x',
      'evil.sh': 'rm -rf /',
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects a non-hex world dir', async () => {
    const arc = buildArchive({
      'manifest.json': goodManifest('not-a-hex-world-id'),
      'SaveGames/0/not-a-hex-world-id/Level.sav': 'x',
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects a manifest/world-dir mismatch', async () => {
    const other = 'FEDCBA9876543210FEDCBA9876543210'
    const arc = buildArchive({
      'manifest.json': goodManifest(other), // manifest claims a different world
      [`SaveGames/0/${WORLD}/Level.sav`]: 'x', // than the actual save dir
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects garbage that is not a tar.gz', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-garbage-'))
    const junk = path.join(src, 'junk.bin')
    fs.writeFileSync(junk, Buffer.from('this is not a gzip stream at all'))
    await expect(service.stageUpload(bodyOf(junk))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects an over-cap upload', async () => {
    env.MAX_UPLOAD_BYTES = 10 // absurdly small
    const arc = buildArchive({
      'manifest.json': goodManifest(),
      [`SaveGames/0/${WORLD}/Level.sav`]: 'x'.repeat(1000),
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'too_large' })
  })
})

describe('restore happy path + rollback', () => {
  it('stages and restores a valid backup, leaving a rollback snapshot', async () => {
    const backup = await service.create('manual', noopSink)
    // Mutate the live save so we can prove the restore replaced it.
    const liveLevel = path.join(env.PAL_DIR, 'Pal/Saved/SaveGames/0', WORLD, 'Level.sav')
    fs.writeFileSync(liveLevel, 'MUTATED-AFTER-BACKUP')

    const preview = await service.stageUpload(bodyOf(path.join(env.BACKUP_DIR, backup.filename)))
    await service.restore(preview.stagingId, WORLD, noopSink)

    // Live level is back to the backed-up content (the fake writes
    // 'fake-level-data' at install).
    expect(fs.readFileSync(liveLevel, 'utf8')).toBe('fake-level-data')
    // A rollback snapshot exists.
    const rollbackRoot = path.join(env.DATA_DIR, 'rollback')
    expect(fs.existsSync(rollbackRoot)).toBe(true)
    expect(fs.readdirSync(rollbackRoot).length).toBeGreaterThan(0)
  })

  it('restore imports the archived server settings (backup ini wins over later edits)', async () => {
    const backup = await service.create('manual', noopSink)
    // Mutate the live settings AFTER the backup, as a user would.
    const iniPath = path.join(env.PAL_DIR, 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini')
    fs.writeFileSync(
      iniPath,
      fs.readFileSync(iniPath, 'utf8').replace('"Fake Palworld Server"', '"Mutated After Backup"'),
    )
    const preview = await service.stageUpload(bodyOf(path.join(env.BACKUP_DIR, backup.filename)))
    await service.restore(preview.stagingId, WORLD, noopSink)
    const after = fs.readFileSync(iniPath, 'utf8')
    expect(after).toContain('"Fake Palworld Server"') // archived value restored
    expect(after).not.toContain('"Mutated After Backup"')
    expect(after).toContain('RESTAPIEnabled=True') // invariants still enforced
    expect(after).toContain('RCONEnabled=False')
  })

  it('refuses restore when the confirmation text is wrong', async () => {
    const backup = await service.create('manual', noopSink)
    const preview = await service.stageUpload(bodyOf(path.join(env.BACKUP_DIR, backup.filename)))
    await expect(service.restore(preview.stagingId, 'nope', noopSink)).rejects.toMatchObject({
      code: 'confirm_mismatch',
    })
  })
})
