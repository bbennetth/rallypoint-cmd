import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// One row per managed game-server instance. `gameSlug` keys into the
// shared GAMES registry; `installDir` and `unitName` are frozen at
// create time (the sudoers file pins systemctl/journalctl argv per
// unit, so unit names are never derived at request time).
export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(), // 'default' for the seeded legacy row, ulid-lowercase otherwise
  gameSlug: text('game_slug').notNull(),
  name: text('name').notNull(),
  installDir: text('install_dir').notNull().unique(),
  unitName: text('unit_name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

export type ServerRow = typeof servers.$inferSelect
export type ServerInsert = typeof servers.$inferInsert
