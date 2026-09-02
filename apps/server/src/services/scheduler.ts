import { Cron } from 'croner'
import { ulid } from 'ulid'
import { desc, eq } from 'drizzle-orm'
import type {
  AnnounceStep,
  Backup,
  BackupPayload,
  CreateScheduleRequest,
  RestartPayload,
  Schedule,
  ScheduleRun,
  UpdateScheduleRequest,
} from '@rallypoint-cmd/shared'
import { backupPayloadSchema, restartPayloadSchema } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import { schedules, scheduleRuns } from '../db/schema/index.js'
import type { GameControl, PlayerAdmin, ServerInstance } from './types.js'
import type { WorldLock } from './world-lock.js'

// Cron-driven restarts + backups, panel-wide: one scheduler owns every
// row across all servers and resolves the row's server instance at fire
// time. The destructive part of every job (the backup, the save+restart)
// takes that instance's world lock (blocking) so it queues behind manual
// ops instead of colliding; a restart's announce countdown — up to an
// hour of broadcasts — runs BEFORE the lock so it doesn't 409 every
// manual backup/restore/update meanwhile. croner's protect:true stops
// overrun stacking (the countdown is inside the job callback).

interface SchedulerDeps {
  env: Env
  db: Db
  logger: Logger
  getInstance(serverId: string): ServerInstance | undefined
  // Injectable so tests can run a countdown without waiting it out.
  sleep?: (ms: number) => Promise<void>
}

export interface SchedulerService {
  start(): void
  stop(): void
  list(serverId: string): Schedule[]
  create(serverId: string, req: CreateScheduleRequest): Schedule
  update(serverId: string, id: string, req: UpdateScheduleRequest): Schedule
  remove(serverId: string, id: string): void
  runs(serverId: string, scheduleId: string): ScheduleRun[]
}

// Retention only governs what the schedule itself produced: manual
// backups ("before the big mod change") and pre-restore snapshots belong
// to the operator and are never pruned here. Pure + exported for tests.
export function selectBackupsToPrune(
  all: readonly Backup[],
  retention: BackupPayload['retention'],
  nowMs: number,
): Backup[] {
  const scheduled = all
    .filter((b) => b.kind === 'scheduled')
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
  if (scheduled.length === 0) return []
  const keepIds = new Set<string>()
  // Always keep the most recent scheduled backup.
  keepIds.add(scheduled[0]!.id)
  if (retention.keepLast) {
    for (const b of scheduled.slice(0, retention.keepLast)) keepIds.add(b.id)
  }
  if (retention.keepDays) {
    const cutoff = nowMs - retention.keepDays * 24 * 60 * 60 * 1000
    for (const b of scheduled) if (b.createdAtMs >= cutoff) keepIds.add(b.id)
  }
  return scheduled.filter((b) => !keepIds.has(b.id))
}

// Turn announce steps into an ordered countdown: each step's wait is the
// gap to the next step, and the last step waits out its own lead time —
// so [{300,"5 min"},{60,"1 min"},{10,"10 s"}] broadcasts at T-300, T-60,
// T-10 and the restart lands at T-0. Pure + exported for tests.
export function planAnnouncements(steps: readonly AnnounceStep[]): { message: string; waitMs: number }[] {
  const sorted = [...steps].sort((a, b) => b.secondsBefore - a.secondsBefore)
  return sorted.map((step, i) => ({
    message: step.message,
    waitMs: (step.secondsBefore - (sorted[i + 1]?.secondsBefore ?? 0)) * 1000,
  }))
}

export type RestartTarget = {
  admin: Pick<PlayerAdmin, 'announce' | 'save'>
  gameControl: Pick<GameControl, 'restart'>
  worldLock: WorldLock
}

// Scheduled restart: countdown (unlocked, best-effort — the game may be
// down or have no admin channel), then save + restart under the world
// lock. acquire() blocks, so a manual op started at T-5 s delays the
// restart until it finishes rather than colliding with it.
export async function runScheduledRestart(
  inst: RestartTarget,
  payload: RestartPayload,
  opts: { label: string; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  const parsed = restartPayloadSchema.parse(payload)
  for (const step of planAnnouncements(parsed.announceSteps)) {
    try {
      await inst.admin.announce(step.message)
    } catch {
      // game down or no query capability — nothing to announce to.
    }
    if (step.waitMs > 0) await opts.sleep(step.waitMs)
  }
  const release = await inst.worldLock.acquire(opts.label)
  try {
    if (parsed.saveBeforeStop) {
      try {
        await inst.admin.save()
      } catch {
        // cold restart is fine
      }
    }
    // systemctl restart is deterministic — systemd owns the bounce and a
    // clean unit exit won't false-trigger Restart=on-failure.
    await inst.gameControl.restart()
  } finally {
    release()
  }
}

export function createScheduler(deps: SchedulerDeps): SchedulerService {
  const { db, logger } = deps
  const sleep = deps.sleep ?? defaultSleep
  const jobs = new Map<string, Cron>()

  function rowToSchedule(row: typeof schedules.$inferSelect): Schedule {
    return {
      id: row.id,
      serverId: row.serverId,
      kind: row.kind,
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
      payload: row.payload as RestartPayload | BackupPayload,
      lastRunAtMs: row.lastRunAt?.getTime() ?? null,
      lastStatus: row.lastStatus ?? null,
      nextRunAtMs: row.nextRunAt?.getTime() ?? null,
      createdAtMs: row.createdAt.getTime(),
    }
  }

  async function runBackup(inst: ServerInstance, payload: BackupPayload, label: string): Promise<void> {
    const parsed = backupPayloadSchema.parse(payload)
    const release = await inst.worldLock.acquire(label)
    try {
      await inst.backup.create('scheduled')
      pruneBackups(inst, parsed)
    } finally {
      release()
    }
  }

  function pruneBackups(inst: ServerInstance, payload: BackupPayload): void {
    // backup.list() is already scoped to this instance's rows (all kinds).
    for (const b of selectBackupsToPrune(inst.backup.list(), payload.retention, Date.now())) {
      try {
        inst.backup.delete(b.id)
      } catch (err) {
        logger.warn('retention prune failed', {
          id: b.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async function execute(scheduleId: string): Promise<void> {
    const row = db.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
    if (!row || !row.enabled) return

    const inst = deps.getInstance(row.serverId)
    if (!inst) {
      logger.warn('schedule fired for a deleted server; skipping', { scheduleId, serverId: row.serverId })
      return
    }

    const runId = ulid()
    db.insert(scheduleRuns).values({ id: runId, scheduleId, startedAt: new Date() }).run()
    logger.info('schedule firing', { scheduleId, serverId: row.serverId, kind: row.kind })

    const label = `schedule:${row.kind}:${scheduleId}`
    let status: 'succeeded' | 'failed' = 'succeeded'
    let detail: string | null = null
    try {
      if (row.kind === 'restart') {
        await runScheduledRestart(inst, row.payload as RestartPayload, { label, sleep })
      } else {
        await runBackup(inst, row.payload as BackupPayload, label)
      }
    } catch (err) {
      status = 'failed'
      detail = err instanceof Error ? err.message : String(err)
      logger.error('schedule run failed', { scheduleId, kind: row.kind, err: detail })
    }

    const now = new Date()
    db.update(scheduleRuns)
      .set({ finishedAt: now, status, detail })
      .where(eq(scheduleRuns.id, runId))
      .run()
    db.update(schedules)
      .set({ lastRunAt: now, lastStatus: status, nextRunAt: nextRunOf(scheduleId) })
      .where(eq(schedules.id, scheduleId))
      .run()
  }

  function schedule(row: typeof schedules.$inferSelect): void {
    unschedule(row.id)
    if (!row.enabled) return
    try {
      const job = new Cron(row.cron, { timezone: row.timezone, protect: true }, () => {
        void execute(row.id)
      })
      jobs.set(row.id, job)
      const next = job.nextRun()
      if (next) {
        db.update(schedules).set({ nextRunAt: next }).where(eq(schedules.id, row.id)).run()
      }
    } catch (err) {
      logger.error('invalid cron; schedule disabled', {
        id: row.id,
        cron: row.cron,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function unschedule(id: string): void {
    jobs.get(id)?.stop()
    jobs.delete(id)
  }

  function nextRunOf(id: string): Date | null {
    return jobs.get(id)?.nextRun() ?? null
  }

  return {
    start() {
      for (const row of db.select().from(schedules).all()) schedule(row)
      logger.info('scheduler started', { jobs: jobs.size })
    },
    stop() {
      for (const job of jobs.values()) job.stop()
      jobs.clear()
    },
    list(serverId) {
      return db
        .select()
        .from(schedules)
        .where(eq(schedules.serverId, serverId))
        .orderBy(desc(schedules.createdAt))
        .all()
        .map(rowToSchedule)
    },
    create(serverId, req) {
      const id = ulid()
      db.insert(schedules)
        .values({
          id,
          serverId,
          kind: req.kind,
          cron: req.cron,
          timezone: req.timezone,
          enabled: req.enabled,
          payload: req.payload,
        })
        .run()
      const row = db.select().from(schedules).where(eq(schedules.id, id)).get()!
      schedule(row)
      return rowToSchedule(db.select().from(schedules).where(eq(schedules.id, id)).get()!)
    },
    update(serverId, id, req) {
      const existing = db.select().from(schedules).where(eq(schedules.id, id)).get()
      if (!existing || existing.serverId !== serverId) throw new Error('schedule not found')
      db.update(schedules)
        .set({
          ...(req.cron !== undefined ? { cron: req.cron } : {}),
          ...(req.timezone !== undefined ? { timezone: req.timezone } : {}),
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
          ...(req.payload !== undefined ? { payload: req.payload } : {}),
        })
        .where(eq(schedules.id, id))
        .run()
      const row = db.select().from(schedules).where(eq(schedules.id, id)).get()!
      schedule(row)
      return rowToSchedule(row)
    },
    remove(serverId, id) {
      const existing = db.select().from(schedules).where(eq(schedules.id, id)).get()
      if (!existing || existing.serverId !== serverId) return
      unschedule(id)
      db.delete(schedules).where(eq(schedules.id, id)).run()
    },
    runs(serverId, scheduleId) {
      const existing = db.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
      if (!existing || existing.serverId !== serverId) return []
      return db
        .select()
        .from(scheduleRuns)
        .where(eq(scheduleRuns.scheduleId, scheduleId))
        .orderBy(desc(scheduleRuns.startedAt))
        .limit(50)
        .all()
        .map((r) => ({
          id: r.id,
          scheduleId: r.scheduleId,
          startedAtMs: r.startedAt.getTime(),
          finishedAtMs: r.finishedAt?.getTime() ?? null,
          status: r.status ?? null,
          detail: r.detail ?? null,
        }))
    },
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
