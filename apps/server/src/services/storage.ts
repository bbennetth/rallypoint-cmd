import path from 'node:path'
import type { BackupDirEntry, GameDirEntry } from '@rallypoint-cmd/shared'
import type { SystemdStatus } from './types.js'

// Pure decision logic for the panel-level storage view and its delete
// endpoints (routes/management.ts), extracted so it unit-tests without
// HTTP or systemd.

// Charset for backup-dir names under PANEL_BACKUP_DIR: a server id (lowercase
// ulid) or the legacy 'default'. Anything else is an operator stray the
// panel neither lists nor touches.
export const SAFE_ID = /^[a-z0-9]{1,32}$/

// Classify first-level GAMES_ROOT dir names against server rows and the
// registry allowlist. Only allowlisted names are deletable — the closed
// list is what makes traversal structurally impossible.
export function classifyGameDirs(
  names: string[],
  rows: { slug: string; id: string; name: string }[],
  allowedSlugs: readonly string[],
): Omit<GameDirEntry, 'sizeBytes' | 'running'>[] {
  return names.map((name) => {
    const row = rows.find((r) => r.slug === name)
    return {
      name,
      registered: row !== undefined,
      ...(row ? { serverId: row.id, serverName: row.name } : {}),
      deletable: allowedSlugs.includes(name),
    }
  })
}

// Classify first-level PANEL_BACKUP_DIR dir names against live server rows.
// Names outside SAFE_ID are dropped entirely.
export function classifyBackupDirs(
  names: string[],
  rows: { id: string; name: string }[],
): Omit<BackupDirEntry, 'sizeBytes'>[] {
  return names
    .filter((name) => SAFE_ID.test(name))
    .map((id) => {
      const row = rows.find((r) => r.id === id)
      return { id, ...(row ? { serverName: row.name } : {}), orphan: row === undefined }
    })
}

// Refuse-to-delete predicate for game files. Mirrors the restore guard:
// a unit that is up (or coming up) refuses, and so does a status we
// failed to read — "unknown" must never read as "safe to rm".
export function deleteRefusal(status: SystemdStatus): 'unit_active' | 'unit_state_unknown' | null {
  if (status.activeState === 'active' || status.activeState === 'activating') return 'unit_active'
  if (status.subState === 'unknown') return 'unit_state_unknown'
  return null
}

// Belt-and-braces on top of the allowlist/charset checks: the resolved
// child must sit strictly inside root.
export function assertSafeChild(root: string, name: string): string {
  const joined = path.resolve(root, name)
  if (!name || name !== path.basename(joined) || path.dirname(joined) !== path.resolve(root)) {
    throw new Error(`refusing unsafe path ${name} under ${root}`)
  }
  return joined
}
