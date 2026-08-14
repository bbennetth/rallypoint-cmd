import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { SAFE_MOD_FILENAME } from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import { buildLogger } from '../logger.js'
import { PAL_MODS_DIR, PAL_MODS_DISABLED_DIR } from './constants.js'
import { createModsService, groupMods, ModError, modStem, type ModsService } from './mods.js'

// Adversarial coverage for the mod-install surface: everything a user
// uploads is untrusted, so the filename allowlist and the zip flattening
// are what stand between an archive and arbitrary writes under PAL_DIR.

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
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    MAX_UNCOMPRESSED_BYTES: 20 * 1024 * 1024,
    PANEL_VERSION: '0.1.0-test',
  }
}

function bodyOf(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buf)
      controller.close()
    },
  })
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

let root: string
let env: Env
let service: ModsService
let modsDir: string
let disabledDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-mods-test-'))
  env = makeEnv(root)
  modsDir = path.join(env.PAL_DIR, PAL_MODS_DIR)
  disabledDir = path.join(env.PAL_DIR, PAL_MODS_DISABLED_DIR)
  service = createModsService(env, buildLogger('error'), env.PAL_DIR)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function expectModError(p: Promise<unknown>, code: ModError['code']): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ModError)
  expect((err as ModError).code).toBe(code)
}

describe('SAFE_MOD_FILENAME', () => {
  it.each([
    'MyMod_P.pak',
    'Mod (v2) [final].pak',
    'a.ucas',
    'b.utoc',
    'c.sig',
    'space name.pak',
  ])('accepts %s', (name) => {
    expect(SAFE_MOD_FILENAME.test(name)).toBe(true)
  })

  it.each([
    '../evil.pak',
    'a/b.pak',
    'a\\b.pak',
    '.hidden.pak',
    '._resource.pak',
    'mod.txt',
    'mod.pak.exe',
    'mod.PAK', // extension is case-sensitive on a Linux fs
    '.pak',
    `${'x'.repeat(300)}.pak`,
  ])('rejects %s', (name) => {
    expect(SAFE_MOD_FILENAME.test(name)).toBe(false)
  })
})

describe('helpers', () => {
  it('modStem strips the final extension only', () => {
    expect(modStem('MyMod_P.pak')).toBe('MyMod_P')
    expect(modStem('a.b.pak')).toBe('a.b')
  })

  it('groupMods groups sidecars under the pak stem and ignores orphans', () => {
    const mods = groupMods([
      { name: 'A_P.pak', sizeBytes: 10, mtimeMs: 100, enabled: true },
      { name: 'A_P.ucas', sizeBytes: 5, mtimeMs: 200, enabled: true },
      { name: 'orphan.ucas', sizeBytes: 1, mtimeMs: 1, enabled: true },
      { name: 'B_P.pak', sizeBytes: 7, mtimeMs: 50, enabled: false },
    ])
    expect(mods.map((m) => m.id)).toEqual(['A_P', 'B_P'])
    expect(mods[0]).toMatchObject({ sizeBytes: 15, modifiedAtMs: 200, enabled: true })
    expect(mods[1]).toMatchObject({ pakFilename: 'B_P.pak', enabled: false })
  })
})

describe('installFromUpload', () => {
  it('installs a bare .pak into ~mods', async () => {
    const { installed } = await service.installFromUpload(bodyOf(bytes('pakdata')), 'MyMod_P.pak')
    expect(installed).toEqual(['MyMod_P'])
    expect(fs.readFileSync(path.join(modsDir, 'MyMod_P.pak'), 'utf8')).toBe('pakdata')
    expect(service.list()).toMatchObject([{ id: 'MyMod_P', enabled: true }])
  })

  it('flattens nested zip entries and skips junk', async () => {
    const zip = zipSync({
      'sub/dir/Nested_P.pak': bytes('nested'),
      'sub/dir/Nested_P.ucas': bytes('sidecar'),
      '__MACOSX/._Nested_P.pak': bytes('junk'),
      'readme.txt': bytes('nope'),
    })
    const { installed } = await service.installFromUpload(bodyOf(zip), 'bundle.zip')
    expect(installed).toEqual(['Nested_P'])
    expect(fs.readdirSync(modsDir).sort()).toEqual(['Nested_P.pak', 'Nested_P.ucas'])
    // Nothing escaped the mods dir.
    expect(fs.existsSync(path.join(modsDir, 'sub'))).toBe(false)
  })

  it('rejects a zip with no paks', async () => {
    const zip = zipSync({ 'only.ucas': bytes('x') })
    await expectModError(service.installFromUpload(bodyOf(zip), 'bundle.zip'), 'no_paks')
    expect(fs.existsSync(modsDir)).toBe(false)
  })

  it('rejects colliding flattened names', async () => {
    const zip = zipSync({ 'a/Same_P.pak': bytes('1'), 'b/Same_P.pak': bytes('2') })
    await expectModError(service.installFromUpload(bodyOf(zip), 'bundle.zip'), 'invalid_archive')
  })

  it('rejects a duplicate of an installed mod, even a disabled one', async () => {
    await service.installFromUpload(bodyOf(bytes('v1')), 'Dup_P.pak')
    await expectModError(service.installFromUpload(bodyOf(bytes('v2')), 'Dup_P.pak'), 'already_exists')
    service.setEnabled('Dup_P', false)
    await expectModError(service.installFromUpload(bodyOf(bytes('v2')), 'Dup_P.pak'), 'already_exists')
    expect(fs.readFileSync(path.join(disabledDir, 'Dup_P.pak'), 'utf8')).toBe('v1')
  })

  it('rejects unsafe or non-pak filenames', async () => {
    await expectModError(service.installFromUpload(bodyOf(bytes('x')), 'notes.txt'), 'invalid_filename')
    await expectModError(service.installFromUpload(bodyOf(bytes('x')), '.hidden.pak'), 'invalid_filename')
    // Sidecars can't be installed standalone — a mod needs its pak.
    await expectModError(service.installFromUpload(bodyOf(bytes('x')), 'solo.ucas'), 'invalid_filename')
  })

  it('rejects an invalid zip body', async () => {
    await expectModError(service.installFromUpload(bodyOf(bytes('not a zip')), 'b.zip'), 'invalid_archive')
  })

  it('caps the streamed upload size', async () => {
    env.MAX_UPLOAD_BYTES = 4
    await expectModError(service.installFromUpload(bodyOf(bytes('12345')), 'Big_P.pak'), 'too_large')
    expect(fs.existsSync(modsDir)).toBe(false)
  })

  it('caps the uncompressed zip size', async () => {
    env.MAX_UNCOMPRESSED_BYTES = 8
    const zip = zipSync({ 'A_P.pak': bytes('0123456789abcdef') })
    await expectModError(service.installFromUpload(bodyOf(zip), 'b.zip'), 'too_large')
  })

  it('cleans up staging on both success and failure', async () => {
    await service.installFromUpload(bodyOf(bytes('ok')), 'Ok_P.pak')
    await expectModError(service.installFromUpload(bodyOf(bytes('x')), 'b.zip'), 'invalid_archive')
    expect(fs.readdirSync(path.join(env.DATA_DIR, 'staging'))).toEqual([])
  })
})

describe('setEnabled / delete', () => {
  it('moves the whole file group between dirs and back', async () => {
    const zip = zipSync({ 'M_P.pak': bytes('p'), 'M_P.ucas': bytes('u'), 'M_P.utoc': bytes('t') })
    await service.installFromUpload(bodyOf(zip), 'm.zip')

    service.setEnabled('M_P', false)
    expect(fs.readdirSync(disabledDir).sort()).toEqual(['M_P.pak', 'M_P.ucas', 'M_P.utoc'])
    expect(fs.readdirSync(modsDir)).toEqual([])
    expect(service.list()).toMatchObject([{ id: 'M_P', enabled: false }])

    service.setEnabled('M_P', false) // idempotent no-op
    service.setEnabled('M_P', true)
    expect(fs.readdirSync(modsDir).sort()).toEqual(['M_P.pak', 'M_P.ucas', 'M_P.utoc'])
    expect(service.list()).toMatchObject([{ id: 'M_P', enabled: true }])
  })

  it('deletes the whole file group from whichever dir holds it', async () => {
    const zip = zipSync({ 'D_P.pak': bytes('p'), 'D_P.sig': bytes('s') })
    await service.installFromUpload(bodyOf(zip), 'd.zip')
    service.setEnabled('D_P', false)
    service.delete('D_P')
    expect(fs.readdirSync(disabledDir)).toEqual([])
    expect(service.list()).toEqual([])
  })

  it('throws not_found for unknown ids (and never joins them into paths)', () => {
    expect(() => service.setEnabled('../../etc/passwd', true)).toThrowError(ModError)
    expect(() => service.delete('nope')).toThrowError(ModError)
  })

  it('lists manually dropped paks (filesystem is the source of truth)', () => {
    fs.mkdirSync(modsDir, { recursive: true })
    fs.writeFileSync(path.join(modsDir, 'Manual_P.pak'), 'x')
    expect(service.list()).toMatchObject([{ id: 'Manual_P', enabled: true }])
  })
})
