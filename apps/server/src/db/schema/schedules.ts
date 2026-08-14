import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(), // ulid
  // Pre-multigame rows are backfilled to the seeded 'default' server.
  // No SQL-level FK: SQLite cannot ADD a REFERENCES column with a
  // non-null default; integrity is app-enforced (compose remove()
  // deletes dependents first).
  serverId: text('server_id').notNull().default('default'),
  kind: text('kind', { enum: ['restart', 'backup'] }).notNull(),
  cron: text('cron').notNull(), // "0 5 * * *"
  timezone: text('timezone').notNull().default('UTC'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  payload: text('payload', { mode: 'json' }).notNull(), // kind-specific JSON
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastStatus: text('last_status', { enum: ['succeeded', 'failed', 'skipped'] }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

export type ScheduleRow = typeof schedules.$inferSelect
export type ScheduleInsert = typeof schedules.$inferInsert

export const scheduleRuns = sqliteTable('schedule_runs', {
  id: text('id').primaryKey(), // ulid
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['succeeded', 'failed', 'skipped'] }),
  detail: text('detail'),
})

export type ScheduleRunRow = typeof scheduleRuns.$inferSelect
