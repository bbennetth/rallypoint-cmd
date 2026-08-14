import { z } from 'zod'

// Scheduled jobs: automatic restarts (Palworld's memory leak makes these
// standard practice) and automatic backups with retention pruning.

export const scheduleKindSchema = z.enum(['restart', 'backup'])
export type ScheduleKind = z.infer<typeof scheduleKindSchema>

export const announceStepSchema = z.object({
  secondsBefore: z.number().int().positive().max(3600),
  message: z.string().min(1).max(600),
})
export type AnnounceStep = z.infer<typeof announceStepSchema>

export const restartPayloadSchema = z.object({
  announceSteps: z.array(announceStepSchema).max(10).default([]),
  saveBeforeStop: z.boolean().default(true),
})
export type RestartPayload = z.infer<typeof restartPayloadSchema>

export const backupPayloadSchema = z.object({
  retention: z.object({
    keepLast: z.number().int().min(1).max(1000).optional(),
    keepDays: z.number().int().min(1).max(3650).optional(),
  }),
})
export type BackupPayload = z.infer<typeof backupPayloadSchema>

export const schedulePayloadSchema = z.union([restartPayloadSchema, backupPayloadSchema])
export type SchedulePayload = z.infer<typeof schedulePayloadSchema>

export const scheduleRunStatusSchema = z.enum(['succeeded', 'failed', 'skipped'])
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>

export const scheduleSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  kind: scheduleKindSchema,
  // Five-field cron expression, e.g. "0 5 * * *".
  cron: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64),
  enabled: z.boolean(),
  payload: schedulePayloadSchema,
  lastRunAtMs: z.number().int().nonnegative().nullable(),
  lastStatus: scheduleRunStatusSchema.nullable(),
  nextRunAtMs: z.number().int().nonnegative().nullable(),
  createdAtMs: z.number().int().nonnegative(),
})
export type Schedule = z.infer<typeof scheduleSchema>

export const createScheduleRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('restart'),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(64).default('UTC'),
    enabled: z.boolean().default(true),
    payload: restartPayloadSchema,
  }),
  z.object({
    kind: z.literal('backup'),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(64).default('UTC'),
    enabled: z.boolean().default(true),
    payload: backupPayloadSchema,
  }),
])
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>

export const updateScheduleRequestSchema = z.object({
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  payload: schedulePayloadSchema.optional(),
})
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>

export const scheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().nullable(),
  status: scheduleRunStatusSchema.nullable(),
  detail: z.string().nullable(),
})
export type ScheduleRun = z.infer<typeof scheduleRunSchema>

export const schedulesResponseSchema = z.object({ schedules: z.array(scheduleSchema) })
export type SchedulesResponse = z.infer<typeof schedulesResponseSchema>

export const scheduleRunsResponseSchema = z.object({ runs: z.array(scheduleRunSchema) })
export type ScheduleRunsResponse = z.infer<typeof scheduleRunsResponseSchema>
