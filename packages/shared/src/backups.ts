import { z } from 'zod'

// Backup archives are tar.gz files under BACKUP_DIR/<serverId>/ holding
// SaveGames/<worldId>/, the two ini files, and a manifest.json. The
// panel's DB row is the source of truth for paths — API callers only
// ever reference backups by id.

export const backupKindSchema = z.enum(['manual', 'scheduled', 'pre_restore'])
export type BackupKind = z.infer<typeof backupKindSchema>

export const backupSchema = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  worldId: z.string(),
  buildId: z.string().nullable(),
  kind: backupKindSchema,
  createdAtMs: z.number().int().nonnegative(),
})
export type Backup = z.infer<typeof backupSchema>

export const backupsResponseSchema = z.object({
  backups: z.array(backupSchema),
})
export type BackupsResponse = z.infer<typeof backupsResponseSchema>

// manifest.json embedded at the root of every archive. Restore refuses
// archives without one that parses.
export const backupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(), // UTC ISO 8601
  worldId: z.string().regex(/^[0-9A-Fa-f]{32}$/),
  buildId: z.string().nullable(),
  panelVersion: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string(),
    }),
  ),
})
export type BackupManifest = z.infer<typeof backupManifestSchema>

// Response to an upload: the archive has been staged + validated but NOT
// applied. The client then POSTs /api/backups/restore with the stagingId
// (and confirm text) to actually swap it in.
export const restorePreviewSchema = z.object({
  stagingId: z.string(),
  manifest: backupManifestSchema,
  currentWorldId: z.string().nullable(),
  worldIdMismatch: z.boolean(),
})
export type RestorePreview = z.infer<typeof restorePreviewSchema>

export const restoreRequestSchema = z.object({
  stagingId: z.string().min(1),
  // The user must type the world id (or "restore") to confirm the
  // destructive swap — checked server-side, not just in the UI.
  confirm: z.string().min(1),
})
export type RestoreRequest = z.infer<typeof restoreRequestSchema>
