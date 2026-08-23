import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Metadata for archives under PANEL_BACKUP_DIR. The `filename` column is the
// only path source download/restore ever use — user input never touches
// the filesystem.
export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(), // ulid
  // Pre-multigame rows are backfilled to the seeded 'default' server.
  // No SQL-level FK: SQLite cannot ADD a REFERENCES column with a
  // non-null default; integrity is app-enforced (compose remove()
  // deletes dependents first).
  serverId: text('server_id').notNull().default('default'),
  filename: text('filename').notNull().unique(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  // Null for games without named worlds (e.g. Enshrouded).
  worldId: text('world_id'),
  buildId: text('build_id'),
  kind: text('kind', { enum: ['manual', 'scheduled', 'pre_restore'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

export type BackupRow = typeof backups.$inferSelect
export type BackupInsert = typeof backups.$inferInsert
