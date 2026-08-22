import { describe, expect, it } from 'vitest'
import path from 'node:path'
import type { SystemdStatus } from './types.js'
import {
  SAFE_ID,
  assertSafeChild,
  classifyBackupDirs,
  classifyGameDirs,
  deleteRefusal,
} from './storage.js'

// The storage view/delete decisions guard an rm -rf of live game data —
// classification, the active-unit refusal, and the path validation each
// get adversarial coverage.

const ALLOWED = ['palworld', 'valheim', 'enshrouded'] as const

describe('classifyGameDirs', () => {
  const rows = [{ slug: 'palworld', id: '01abc', name: 'My Palworld' }]

  it('marks a dir with a server row as registered and deletable', () => {
    const [entry] = classifyGameDirs(['palworld'], rows, ALLOWED)
    expect(entry).toEqual({
      name: 'palworld',
      registered: true,
      serverId: '01abc',
      serverName: 'My Palworld',
      deletable: true,
    })
  })

  it('marks a registry slug without a row as an unregistered orphan, still deletable', () => {
    const [entry] = classifyGameDirs(['valheim'], rows, ALLOWED)
    expect(entry).toEqual({ name: 'valheim', registered: false, deletable: true })
  })

  it('lists non-registry strays but never marks them deletable', () => {
    const [entry] = classifyGameDirs(['lost+found'], rows, ALLOWED)
    expect(entry).toEqual({ name: 'lost+found', registered: false, deletable: false })
  })
})

describe('classifyBackupDirs', () => {
  const rows = [{ id: '01hgw2bbharsvyyyyyyyyyyyyy', name: 'My Palworld' }]

  it('resolves a live server dir to its name', () => {
    const [entry] = classifyBackupDirs(['01hgw2bbharsvyyyyyyyyyyyyy'], rows)
    expect(entry).toEqual({
      id: '01hgw2bbharsvyyyyyyyyyyyyy',
      serverName: 'My Palworld',
      orphan: false,
    })
  })

  it('marks a rowless dir as an orphan', () => {
    const [entry] = classifyBackupDirs(['01other0000000000000000000'], rows)
    expect(entry).toEqual({ id: '01other0000000000000000000', orphan: true })
  })

  it("accepts the legacy 'default' id", () => {
    expect(classifyBackupDirs(['default'], [])).toEqual([{ id: 'default', orphan: true }])
  })

  it('drops names outside the safe charset entirely', () => {
    expect(classifyBackupDirs(['.tmp-x', 'UPPER', 'a/b', '..'], [])).toEqual([])
  })
})

describe('SAFE_ID', () => {
  it('matches lowercase ulids and default, rejects everything else', () => {
    expect(SAFE_ID.test('01hgw2bbharsvyyyyyyyyyyyyy')).toBe(true)
    expect(SAFE_ID.test('default')).toBe(true)
    expect(SAFE_ID.test('')).toBe(false)
    expect(SAFE_ID.test('has-dash')).toBe(false)
    expect(SAFE_ID.test('a'.repeat(33))).toBe(false)
  })
})

describe('deleteRefusal', () => {
  const status = (activeState: string, subState: string): SystemdStatus => ({
    installed: true,
    activeState,
    subState,
    memoryCurrentBytes: null,
    activeEnterAtMs: null,
  })

  it('refuses active and activating units', () => {
    expect(deleteRefusal(status('active', 'running'))).toBe('unit_active')
    expect(deleteRefusal(status('activating', 'start'))).toBe('unit_active')
  })

  it("refuses when the unit state could not be read ('unknown' is not 'safe')", () => {
    expect(deleteRefusal(status('inactive', 'unknown'))).toBe('unit_state_unknown')
  })

  it('allows inactive, failed and deactivating-finished units', () => {
    expect(deleteRefusal(status('inactive', 'dead'))).toBeNull()
    expect(deleteRefusal(status('failed', 'failed'))).toBeNull()
  })
})

describe('assertSafeChild', () => {
  const root = path.join(path.sep, 'opt', 'games')

  it('returns the joined path for a plain name', () => {
    expect(assertSafeChild(root, 'palworld')).toBe(path.join(root, 'palworld'))
  })

  it('rejects traversal, separators, absolutes and empties', () => {
    expect(() => assertSafeChild(root, '..')).toThrow(/unsafe path/)
    expect(() => assertSafeChild(root, 'a/b')).toThrow(/unsafe path/)
    expect(() => assertSafeChild(root, '/etc')).toThrow(/unsafe path/)
    expect(() => assertSafeChild(root, '')).toThrow(/unsafe path/)
    expect(() => assertSafeChild(root, '.')).toThrow(/unsafe path/)
  })
})
