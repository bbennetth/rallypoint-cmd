import { describe, expect, it } from 'vitest'
import {
  MANAGED_KEYS,
  PAL_KEY_SPECS,
  settingsPatchSchema,
  settingsResponseSchema,
} from './settings.js'
import { createScheduleRequestSchema, restartPayloadSchema } from './schedules.js'
import { backupManifestSchema } from './backups.js'
import { serverStatusSchema } from './server-status.js'

describe('settings contract', () => {
  it('marks every managed key as managed in the spec table', () => {
    for (const key of MANAGED_KEYS) {
      expect(PAL_KEY_SPECS[key]?.managed, key).toBe(true)
    }
  })

  it('accepts a mixed-type settings patch', () => {
    const patch = settingsPatchSchema.parse({
      values: { ServerName: 'My World', ExpRate: 1.5, bIsPvP: false },
    })
    expect(patch.values['ExpRate']).toBe(1.5)
  })

  it('round-trips a settings response entry', () => {
    const res = settingsResponseSchema.parse({
      entries: [
        {
          key: 'ExpRate',
          raw: '1.000000',
          value: 1,
          kind: 'float',
          enumValues: null,
          managed: false,
          label: 'XP rate',
          category: 'World & Gameplay',
        },
      ],
      categories: ['World & Gameplay'],
      pendingRestart: false,
    })
    expect(res.entries[0]?.key).toBe('ExpRate')
    expect(res.entries[0]?.category).toBe('World & Gameplay')
  })
})

describe('schedules contract', () => {
  it('defaults restart payload fields', () => {
    const payload = restartPayloadSchema.parse({})
    expect(payload.saveBeforeStop).toBe(true)
    expect(payload.announceSteps).toEqual([])
  })

  it('discriminates create requests by kind', () => {
    const req = createScheduleRequestSchema.parse({
      kind: 'backup',
      cron: '0 4 * * *',
      payload: { retention: { keepLast: 7 } },
    })
    expect(req.kind).toBe('backup')
    expect(req.timezone).toBe('UTC')
  })
})

describe('backup manifest contract', () => {
  it('requires a 32-hex world id', () => {
    const good = backupManifestSchema.safeParse({
      schemaVersion: 1,
      createdAt: '2026-07-19T00:00:00Z',
      worldId: 'A'.repeat(32),
      buildId: '123456',
      panelVersion: '0.1.0',
      files: [],
    })
    expect(good.success).toBe(true)
    const bad = backupManifestSchema.safeParse({
      schemaVersion: 1,
      createdAt: '2026-07-19T00:00:00Z',
      worldId: '../evil',
      buildId: null,
      panelVersion: '0.1.0',
      files: [],
    })
    expect(bad.success).toBe(false)
  })

  it('accepts a null world id and a game field (world-id-free games)', () => {
    const res = backupManifestSchema.safeParse({
      schemaVersion: 1,
      createdAt: '2026-08-22T00:00:00Z',
      game: 'enshrouded',
      worldId: null,
      buildId: '123456',
      panelVersion: '0.1.0',
      files: [],
    })
    expect(res.success).toBe(true)
    const traversal = backupManifestSchema.safeParse({
      schemaVersion: 1,
      createdAt: '2026-08-22T00:00:00Z',
      game: 'enshrouded',
      worldId: '../evil',
      buildId: null,
      panelVersion: '0.1.0',
      files: [],
    })
    expect(traversal.success).toBe(false)
  })
})

describe('server status contract', () => {
  it('parses a not_installed status', () => {
    const status = serverStatusSchema.parse({
      lifecycle: 'not_installed',
      pendingRestart: false,
      buildId: null,
      world: { id: null, lastSavedAtMs: null },
      systemd: {
        activeState: 'inactive',
        subState: 'dead',
        memoryCurrentBytes: null,
        activeEnterAtMs: null,
      },
      rest: { reachable: false },
      disks: [],
    })
    expect(status.lifecycle).toBe('not_installed')
  })
})
