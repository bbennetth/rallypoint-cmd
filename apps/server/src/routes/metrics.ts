import { Hono } from 'hono'
import type { MetricsSnapshot } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'

// Resource telemetry for one server. The sampler polls on its own timer,
// so this handler is a pure memory read — polling it every few seconds
// from the UI costs nothing and can't be made slow by a wedged game.

export const metricsRoutes = new Hono<HonoApp>()

metricsRoutes.get('/metrics', requireSession, (c) => {
  const snapshot: MetricsSnapshot = c.get('services').metrics.snapshot()
  return c.json(snapshot)
})
