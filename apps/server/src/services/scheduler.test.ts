import { describe, expect, it } from 'vitest'
import type { Backup, BackupKind } from '@rallypoint-cmd/shared'
import { planAnnouncements, runScheduledRestart, selectBackupsToPrune } from './scheduler.js'
import { WorldLock } from './world-lock.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 2, 3, 0, 0)

function backup(id: string, kind: BackupKind, ageDays: number): Backup {
  return {
    id,
    filename: `${id}.tar.gz`,
    sizeBytes: 1,
    sha256: 'x',
    worldId: null,
    buildId: null,
    kind,
    createdAtMs: NOW - ageDays * DAY,
  }
}

const ids = (list: Backup[]): string[] => list.map((b) => b.id)

describe('selectBackupsToPrune', () => {
  // The bug: retention used to run over every backup kind, so a nightly
  // keepLast:3 deleted the operator's manual "before the mod change" backup.
  const mixed = [
    backup('manual-new', 'manual', 0),
    backup('sched-1', 'scheduled', 1),
    backup('pre-restore', 'pre_restore', 2),
    backup('sched-3', 'scheduled', 3),
    backup('sched-4', 'scheduled', 4),
    backup('manual-old', 'manual', 30),
  ]

  it('never prunes manual or pre-restore backups', () => {
    expect(ids(selectBackupsToPrune(mixed, { keepLast: 1 }, NOW))).toEqual(['sched-3', 'sched-4'])
  })

  it('applies keepDays to scheduled backups only', () => {
    expect(ids(selectBackupsToPrune(mixed, { keepDays: 2 }, NOW))).toEqual(['sched-3', 'sched-4'])
  })

  it('keeps the union of keepLast and keepDays', () => {
    expect(ids(selectBackupsToPrune(mixed, { keepLast: 1, keepDays: 3.5 }, NOW))).toEqual(['sched-4'])
  })

  it('always keeps the newest scheduled backup even with empty retention', () => {
    expect(ids(selectBackupsToPrune(mixed, {}, NOW))).toEqual(['sched-3', 'sched-4'])
  })

  it('does not rely on the input order', () => {
    const shuffled = [...mixed].reverse()
    expect(ids(selectBackupsToPrune(shuffled, { keepLast: 2 }, NOW))).toEqual(['sched-4'])
  })

  it('returns nothing when there are no scheduled backups', () => {
    expect(selectBackupsToPrune([backup('m', 'manual', 1), backup('p', 'pre_restore', 9)], { keepLast: 1 }, NOW)).toEqual([])
    expect(selectBackupsToPrune([], { keepLast: 1 }, NOW)).toEqual([])
  })
})

describe('planAnnouncements', () => {
  it('orders steps by lead time and waits the gap between them', () => {
    expect(
      planAnnouncements([
        { secondsBefore: 60, message: '1 min' },
        { secondsBefore: 600, message: '10 min' },
        { secondsBefore: 10, message: '10 s' },
      ]),
    ).toEqual([
      { message: '10 min', waitMs: 540_000 },
      { message: '1 min', waitMs: 50_000 },
      { message: '10 s', waitMs: 10_000 },
    ])
  })

  it('a single step waits out its whole lead time', () => {
    expect(planAnnouncements([{ secondsBefore: 30, message: 'x' }])).toEqual([{ message: 'x', waitMs: 30_000 }])
  })

  it('handles duplicates and no steps', () => {
    expect(planAnnouncements([{ secondsBefore: 5, message: 'a' }, { secondsBefore: 5, message: 'b' }]).map((s) => s.waitMs)).toEqual([0, 5000])
    expect(planAnnouncements([])).toEqual([])
  })
})

describe('runScheduledRestart', () => {
  const LABEL = 'schedule:restart:x'
  function target() {
    const worldLock = new WorldLock()
    const calls: string[] = []
    const sleeps: number[] = []
    const inst = {
      worldLock,
      admin: {
        announce: async (m: string) => {
          calls.push(`announce:${m}`)
        },
        save: async () => {
          calls.push('save')
        },
      },
      gameControl: {
        restart: async () => {
          calls.push('restart')
        },
      },
    }
    const sleep = async (ms: number) => {
      // The countdown must not hold the world lock (someone else may).
      expect(worldLock.holder).not.toBe(LABEL)
      sleeps.push(ms)
    }
    return { inst, calls, sleeps, sleep, worldLock }
  }

  it('honours secondsBefore between announcements and restarts under the lock', async () => {
    const { inst, calls, sleeps, sleep, worldLock } = target()
    // The bug: every step was followed by a flat 1 s sleep, so a
    // 5 min / 1 min / 10 s countdown fired in 3 s and restarted at once.
    await runScheduledRestart(
      inst,
      {
        announceSteps: [
          { secondsBefore: 300, message: '5 min' },
          { secondsBefore: 60, message: '1 min' },
          { secondsBefore: 10, message: '10 s' },
        ],
        saveBeforeStop: true,
      },
      { label: LABEL, sleep },
    )
    expect(sleeps).toEqual([240_000, 50_000, 10_000])
    expect(calls).toEqual(['announce:5 min', 'announce:1 min', 'announce:10 s', 'save', 'restart'])
    expect(worldLock.holder).toBeNull()
  })

  it('waits for a manual op holding the lock before restarting', async () => {
    const { inst, calls, sleep, worldLock } = target()
    const releaseManual = worldLock.tryAcquire('backup:manual')!
    const run = runScheduledRestart(
      inst,
      { announceSteps: [{ secondsBefore: 10, message: 'soon' }], saveBeforeStop: false },
      { label: LABEL, sleep },
    )
    await new Promise((r) => setImmediate(r))
    expect(calls).toEqual(['announce:soon']) // countdown done, restart queued
    releaseManual()
    await run
    expect(calls).toEqual(['announce:soon', 'restart'])
    expect(worldLock.holder).toBeNull()
  })

  it('keeps counting down when the game cannot be reached', async () => {
    const { inst, calls, sleeps, sleep } = target()
    inst.admin.announce = async () => {
      throw new Error('rcon down')
    }
    await runScheduledRestart(
      inst,
      { announceSteps: [{ secondsBefore: 20, message: 'x' }], saveBeforeStop: false },
      { label: LABEL, sleep },
    )
    expect(sleeps).toEqual([20_000])
    expect(calls).toEqual(['restart'])
  })
})
