import { z } from 'zod'
import { longOpSchema } from './api.js'
import { diskUsageSchema } from './server-status.js'

// Panel-level storage view: what actually sits on disk under GAMES_ROOT
// and BACKUP_DIR, including directories with no corresponding server row
// (server deletion is an unregistration, not an uninstall — orphans are
// the expected steady state and exactly what's worth reclaiming).

export const gameDirEntrySchema = z.object({
  // First-level directory name under GAMES_ROOT (a registry slug for
  // panel-created installs; anything else is an unmanaged stray).
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  // A servers row exists whose game slug matches this directory.
  registered: z.boolean(),
  serverId: z.string().optional(),
  serverName: z.string().optional(),
  // Registered dirs only: systemd unit is active/activating.
  running: z.boolean().optional(),
  // Name is a registry slug, so the delete endpoint will accept it.
  deletable: z.boolean(),
})
export type GameDirEntry = z.infer<typeof gameDirEntrySchema>

export const backupDirEntrySchema = z.object({
  // Directory name under BACKUP_DIR: a server id (lowercase ulid) or the
  // legacy 'default'.
  id: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  serverName: z.string().optional(),
  // No live servers row with this id.
  orphan: z.boolean(),
})
export type BackupDirEntry = z.infer<typeof backupDirEntrySchema>

export const panelStorageSchema = z.object({
  disks: z.array(diskUsageSchema),
  games: z.array(gameDirEntrySchema),
  backups: z.array(backupDirEntrySchema),
})
export type PanelStorage = z.infer<typeof panelStorageSchema>

// Currently- or last-run op on the panel-level runner (panel_update,
// public_access, storage deletes); null before anything ever ran.
export const panelOpStateSchema = z.object({ op: longOpSchema.nullable() })
export type PanelOpState = z.infer<typeof panelOpStateSchema>

// Typed confirmation, re-checked server-side (restore precedent): the
// client sends the name the user typed, never the path.
export const storageDeleteRequestSchema = z.object({ confirm: z.string() })
export type StorageDeleteRequest = z.infer<typeof storageDeleteRequestSchema>
