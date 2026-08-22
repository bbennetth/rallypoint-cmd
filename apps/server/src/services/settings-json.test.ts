import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import type { Env } from '../env.js'
import {
  applyEnshroudedInvariants,
  createEnshroudedSettings,
  flattenScalars,
  JsonParseError,
} from './settings-json.js'
import type { SettingsService } from './settings-ini.js'

const SAMPLE = {
  name: 'My Server',
  password: 'hunter2',
  saveDirectory: './savegame',
  logDirectory: './logs',
  ip: '0.0.0.0',
  queryPort: 15637,
  slotCount: 16,
  gameSettingsPreset: 'Default',
  enableVoiceChat: false,
  gameSettings: {
    playerHealthFactor: 1,
    enemyDamageFactor: 1,
    tombstoneMode: 'AddBackpackMaterials',
    weatherFrequency: 'Normal',
    someFutureKey: 2.5,
  },
  userGroups: [
    { name: 'Admin', password: 'AdminXXXXXXXX', canKickBan: true },
    { name: 'Guest', password: 'GuestXXXXXXXX', canKickBan: false },
  ],
}

let root: string
let installDir: string
let service: SettingsService
let closeDb: () => void
let jsonPath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensh-settings-test-'))
  installDir = path.join(root, 'enshrouded')
  fs.mkdirSync(installDir, { recursive: true })
  jsonPath = path.join(installDir, 'enshrouded_server.json')
  fs.writeFileSync(jsonPath, JSON.stringify(SAMPLE, null, 4))
  const env = { DATA_DIR: path.join(root, 'panel') } as Env
  fs.mkdirSync(env.DATA_DIR, { recursive: true })
  const { db, sqlite } = createDb(path.join(env.DATA_DIR, 'panel.sqlite'))
  runMigrations(db)
  closeDb = () => sqlite.close()
  service = createEnshroudedSettings(env, db, {
    installDir,
    stateKey: 'pendingRestart:test',
    gamePort: 15636,
    queryPort: 15637,
  })
})

afterEach(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

function fileObj(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
}

describe('read()', () => {
  it('flattens scalars to dot-path entries with specs and categories', () => {
    const { entries, categories } = service.read()
    const byKey = new Map(entries.map((e) => [e.key, e]))
    expect(byKey.get('name')).toMatchObject({ kind: 'string', value: 'My Server', category: 'Server & Network' })
    expect(byKey.get('gameSettings.tombstoneMode')).toMatchObject({
      kind: 'enum',
      value: 'AddBackpackMaterials',
    })
    expect(byKey.get('queryPort')?.managed).toBe(true)
    // Unknown scalar surfaces as a raw-only entry; arrays don't surface.
    expect(byKey.get('gameSettings.someFutureKey')).toMatchObject({ kind: null, raw: '2.5' })
    expect(byKey.has('userGroups')).toBe(false)
    expect(categories).toContain('Difficulty & Survival')
  })

  it('throws a helpful JsonParseError when the file is missing', () => {
    fs.rmSync(jsonPath)
    expect(() => service.read()).toThrowError(/start it once/)
  })

  it('throws JsonParseError on garbage JSON', () => {
    fs.writeFileSync(jsonPath, '{not json')
    expect(() => service.read()).toThrowError(JsonParseError)
  })
})

describe('writeStructured()', () => {
  it('writes dot-path keys and preserves userGroups + unknown keys', () => {
    service.writeStructured({ slotCount: 8, 'gameSettings.enemyDamageFactor': 1.5 })
    const obj = fileObj()
    expect(obj['slotCount']).toBe(8)
    expect((obj['gameSettings'] as Record<string, unknown>)['enemyDamageFactor']).toBe(1.5)
    expect(obj['userGroups']).toEqual(SAMPLE.userGroups)
    expect((obj['gameSettings'] as Record<string, unknown>)['someFutureKey']).toBe(2.5)
    expect(service.getPendingRestart()).toBe(true)
  })

  it('rejects managed keys', () => {
    expect(() => service.writeStructured({ queryPort: 9999 })).toThrowError(/panel-managed/)
    expect(() => service.writeStructured({ saveDirectory: '/tmp' })).toThrowError(/panel-managed/)
  })

  it('validates enum membership', () => {
    expect(() => service.writeStructured({ 'gameSettings.tombstoneMode': 'Nope' })).toThrowError(
      /must be one of/,
    )
  })

  it('accepts an unknown-but-present scalar as a JSON scalar literal only', () => {
    service.writeStructured({ 'gameSettings.someFutureKey': '3.5' })
    expect((fileObj()['gameSettings'] as Record<string, unknown>)['someFutureKey']).toBe(3.5)
    expect(() => service.writeStructured({ 'gameSettings.someFutureKey': '{"a":1}' })).toThrowError(
      /scalar/,
    )
    expect(() => service.writeStructured({ neverExisted: 'x' })).toThrowError(/not present/)
  })
})

describe('invariants', () => {
  it('re-enforces ip/ports/dirs on raw writes', () => {
    service.writeRaw(
      JSON.stringify({
        ...SAMPLE,
        ip: '127.0.0.1',
        queryPort: 1,
        saveDirectory: '/somewhere/else',
        logDirectory: '/tmp/logs',
      }),
    )
    const obj = fileObj()
    expect(obj['ip']).toBe('0.0.0.0')
    expect(obj['queryPort']).toBe(15637)
    expect(obj['saveDirectory']).toBe('./savegame')
    expect(obj['logDirectory']).toBe('./logs')
  })

  it('enforces gamePort only when the key exists (newer builds dropped it)', () => {
    const withPort = { gamePort: 1, queryPort: 2 }
    applyEnshroudedInvariants(withPort as Record<string, unknown>, { gamePort: 15636, queryPort: 15637 })
    expect(withPort.gamePort).toBe(15636)
    const without: Record<string, unknown> = { queryPort: 2 }
    applyEnshroudedInvariants(without, { gamePort: 15636, queryPort: 15637 })
    expect('gamePort' in without).toBe(false)
  })

  it('rejects raw content that is not a JSON object', () => {
    expect(() => service.writeRaw('[1,2,3]')).toThrowError(/JSON object/)
    expect(() => service.writeRaw('garbage')).toThrowError(JsonParseError)
  })
})

describe('seedIfMissing()', () => {
  it('writes the minimal template only when the file is absent', () => {
    fs.rmSync(jsonPath)
    service.seedIfMissing()
    const obj = fileObj()
    expect(obj['queryPort']).toBe(15637)
    expect(obj['gameSettingsPreset']).toBe('Default')
    expect(service.getPendingRestart()).toBe(false)

    // Present file untouched.
    fs.writeFileSync(jsonPath, JSON.stringify({ name: 'existing' }))
    service.seedIfMissing()
    expect(fileObj()['name']).toBe('existing')
  })
})

describe('flattenScalars', () => {
  it('skips arrays and nested objects below one level', () => {
    const flat = flattenScalars({ a: 1, b: { c: 'x', d: [1], e: { deep: true } }, f: [2] })
    expect(flat).toEqual([
      { key: 'a', value: 1 },
      { key: 'b.c', value: 'x' },
    ])
  })
})
