import { Hono } from 'hono'
import { createScheduleRequestSchema, updateScheduleRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'

export const scheduleRoutes = new Hono<HonoApp>()

scheduleRoutes.get('/schedules', requireSession, (c) => {
  const { scheduler, instance } = c.get('services')
  return c.json({ schedules: scheduler.list(instance.id) })
})

scheduleRoutes.post('/schedules', requireSession, async (c) => {
  const body = createScheduleRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  const { scheduler, instance } = c.get('services')
  const schedule = scheduler.create(instance.id, body.data)
  c.get('logger').info('schedule created', { id: schedule.id, kind: schedule.kind })
  return c.json(schedule, 201)
})

scheduleRoutes.patch('/schedules/:id', requireSession, async (c) => {
  const body = updateScheduleRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    const { scheduler, instance } = c.get('services')
    return c.json(scheduler.update(instance.id, c.req.param('id'), body.data))
  } catch {
    throw errors.notFound('Schedule')
  }
})

scheduleRoutes.delete('/schedules/:id', requireSession, (c) => {
  const { scheduler, instance } = c.get('services')
  scheduler.remove(instance.id, c.req.param('id'))
  return c.json({ ok: true as const })
})

scheduleRoutes.get('/schedules/:id/runs', requireSession, (c) => {
  const { scheduler, instance } = c.get('services')
  return c.json({ runs: scheduler.runs(instance.id, c.req.param('id')) })
})
