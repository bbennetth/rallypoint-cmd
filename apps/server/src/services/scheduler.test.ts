import { describe, expect, it } from 'vitest'
import type { Backup, BackupKind } from '@rallypoint-cmd/shared'
import { selectBackupsToPrune } from './scheduler.js'

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
