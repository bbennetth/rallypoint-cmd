import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { createDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import type { Env } from '../env.js'
import { buildLogger } from '../logger.js'
import { GAMES } from '@rallypoint-cmd/shared'
import { createFakeInstanceServices } from './fake/index.js'
import { servers } from '../db/schema/index.js'
import { createEnshroudedSettings } from './settings-json.js'
import { createBackupService, type BackupService } from './backup.js'
import { enshroudedContract } from './backup-contracts.js'
import type { OpSink } from './types.js'

// The world-id-free variant of the backup contract: Enshrouded archives
// hold savegame/** + enshrouded_server.json + manifest.json with
// worldId: null throughout.

const noopSink: OpSink = { line: () => {}, progress: () => {} }
const SERVER_ID = 'enshrouded'

function makeEnv(root: string): Env {
  return {
    NODE_ENV: 'test',
    PANEL_MODE: 'mock',
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: 0,
    DATA_DIR: path.join(root, 'panel'),
    PANEL_BACKUP_DIR: path.join(root, 'backups'),
    STEAMCMD_BIN: path.join(root, 'steamcmd.sh'),
    DB_PATH: path.join(root, 'panel', 'panel.sqlite'),
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

function buildArchive(files: Record<string, string>): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ensh-arc-src-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(src, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const out = path.join(src, 'archive.tar.gz')
  tar.create(
    { gzip: true, cwd: src, file: out, portable: true, sync: true },
    fs.readdirSync(src).filter((f) => f !== 'archive.tar.gz'),
  )
  return out
}

function enshroudedManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date('2026-08-22T00:00:00Z').toISOString(),
    game: 'enshrouded',
    worldId: null,
    buildId: '20260822',
    panelVersion: '0.1.0-test',
    files: [],
    ...overrides,
  })
}

let root: string
let env: Env
let installDir: string
let service: BackupService
let closeDb: () => void

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensh-backup-test-'))
  env = makeEnv(root)
  installDir = path.join(root, 'enshrouded')
  const logger = buildLogger('error')
  const { db, sqlite } = createDb(env.DB_PATH)
  runMigrations(db)
  closeDb = () => sqlite.close()
  const fakes = createFakeInstanceServices(env, logger, installDir, GAMES['enshrouded']!)
  db.insert(servers)
    .values({
      id: SERVER_ID,
      gameSlug: 'enshrouded',
      name: 'Enshrouded',
      installDir,
      unitName: 'rallypoint-game@enshrouded.service',
    })
    .run()
  await fakes.steamcmd.run('install', noopSink)
  await fakes.gameControl.start()
  service = createBackupService({
    env,
    db,
    logger,
    gameControl: fakes.gameControl,
    query: fakes.query, // null query — no save-flush API
    steamcmd: fakes.steamcmd,
    settings: createEnshroudedSettings(env, db, {
      installDir,
      stateKey: `pendingRestart:${SERVER_ID}`,
      gamePort: 15636,
      queryPort: 15637,
    }),
    serverId: SERVER_ID,
    installDir,
    backupDir: env.PANEL_BACKUP_DIR,
    contract: enshroudedContract,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('enshrouded backup create + round-trip', () => {
  it('creates a world-id-free backup and re-validates it', async () => {
    const backup = await service.create('manual', noopSink)
    expect(backup.worldId).toBeNull()
    expect(backup.filename.startsWith('enshrouded-')).toBe(true)
    expect(fs.existsSync(path.join(env.PANEL_BACKUP_DIR, backup.filename))).toBe(true)

    const listed: string[] = []
    await tar.list({
      file: path.join(env.PANEL_BACKUP_DIR, backup.filename),
      onReadEntry: (e) => void listed.push(e.path),
    })
    expect(listed.some((p) => p.replace(/\/$/, '') === 'enshrouded_server.json')).toBe(true)
    expect(listed.some((p) => p.startsWith('savegame/'))).toBe(true)

    const preview = await service.stageUpload(bodyOf(path.join(env.PANEL_BACKUP_DIR, backup.filename)))
    expect(preview.manifest.worldId).toBeNull()
    expect(preview.manifest.game).toBe('enshrouded')
    expect(preview.currentWorldId).toBeNull()
    expect(preview.worldIdMismatch).toBe(false)
  })

  it('errors with no_world when the savegame dir is empty', async () => {
    fs.rmSync(path.join(installDir, 'savegame'), { recursive: true, force: true })
    await expect(service.create('manual', noopSink)).rejects.toMatchObject({ code: 'no_world' })
  })
})

describe('enshrouded archive guardrails', () => {
  it('rejects a palworld-shaped archive (cross-game guard by content)', async () => {
    const arc = buildArchive({
      'manifest.json': JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-08-22T00:00:00Z',
        worldId: '0123456789ABCDEF0123456789ABCDEF',
        buildId: null,
        panelVersion: '0.1.0-test',
        files: [],
      }),
      'SaveGames/0/0123456789ABCDEF0123456789ABCDEF/Level.sav': 'x',
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects a manifest claiming another game even when the layout matches', async () => {
    const arc = buildArchive({
      'manifest.json': enshroudedManifest({ game: 'palworld', worldId: null }),
      'savegame/world': 'x',
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects an archive with zero savegame files', async () => {
    const arc = buildArchive({ 'manifest.json': enshroudedManifest() })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })

  it('rejects unexpected top-level entries', async () => {
    const arc = buildArchive({
      'manifest.json': enshroudedManifest(),
      'savegame/world': 'x',
      'evil.sh': 'rm -rf /',
    })
    await expect(service.stageUpload(bodyOf(arc))).rejects.toMatchObject({ code: 'archive_invalid' })
  })
})

describe('enshrouded restore', () => {
  it('restores with the literal "restore" confirmation and swaps savegame/', async () => {
    const backup = await service.create('manual', noopSink)
    const liveWorld = path.join(installDir, 'savegame', '3ad85aea')
    fs.writeFileSync(liveWorld, 'MUTATED-AFTER-BACKUP')

    const preview = await service.stageUpload(bodyOf(path.join(env.PANEL_BACKUP_DIR, backup.filename)))
    await service.restore(preview.stagingId, 'restore', noopSink)

    expect(fs.readFileSync(liveWorld, 'utf8')).toBe('fake-enshrouded-world')
    const rollbackRoot = path.join(env.DATA_DIR, 'rollback')
    expect(fs.readdirSync(rollbackRoot).length).toBeGreaterThan(0)
  })

  it('imports the archived enshrouded_server.json with invariants re-enforced', async () => {
    const backup = await service.create('manual', noopSink)
    const cfgPath = path.join(installDir, 'enshrouded_server.json')
    const mutated = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    mutated['name'] = 'Mutated After Backup'
    fs.writeFileSync(cfgPath, JSON.stringify(mutated, null, 4))

    const preview = await service.stageUpload(bodyOf(path.join(env.PANEL_BACKUP_DIR, backup.filename)))
    await service.restore(preview.stagingId, 'restore', noopSink)

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    expect(after['name']).toBe('Fake Enshrouded Server')
    expect(after['queryPort']).toBe(15637) // invariant re-enforced
    expect(after['saveDirectory']).toBe('./savegame')
  })

  it('refuses a wrong confirmation', async () => {
    const backup = await service.create('manual', noopSink)
    const preview = await service.stageUpload(bodyOf(path.join(env.PANEL_BACKUP_DIR, backup.filename)))
    await expect(service.restore(preview.stagingId, 'nope', noopSink)).rejects.toMatchObject({
      code: 'confirm_mismatch',
    })
  })
})
