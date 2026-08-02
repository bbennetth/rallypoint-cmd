import { Hono } from 'hono'
import { publicAccessConsoleSchema, publicAccessStatusSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { LongOpConflictError } from '../services/long-op.js'

export const publicAccessRoutes = new Hono<HonoApp>()

publicAccessRoutes.get('/api/public-access', requireSession, async (c) => {
  const { publicAccess } = c.get('services')
  return c.json(publicAccessStatusSchema.parse(await publicAccess.status()))
})

// Enable = install (if needed) + claim + start, as a long-op streaming
// over /api/updates/stream (the claim URL is emitted as a log line and
// also surfaced via GET status pendingClaim). No world lock — this never
// touches game files.
publicAccessRoutes.post('/api/public-access/enable', requireSession, (c) => {
  const { publicAccess, longOps } = c.get('services')
  try {
    const op = longOps.start('public_access', (sink) => publicAccess.enable(sink))
    return c.json(op, 202)
  } catch (err) {
    if (err instanceof LongOpConflictError) {
      throw errors.conflict('op_running', `A ${err.running.kind} operation is already running.`)
    }
    throw err
  }
})

publicAccessRoutes.post('/api/public-access/disable', requireSession, async (c) => {
  const { publicAccess } = c.get('services')
  await publicAccess.disable()
  return c.json({ ok: true as const })
})

// Diagnostics: the panel↔playit trace (helper calls + api.playit.gg
// exchanges, secret-redacted) and the agent's recent journal lines.
publicAccessRoutes.get('/api/public-access/console', requireSession, async (c) => {
  const { publicAccess } = c.get('services')
  return c.json(publicAccessConsoleSchema.parse(await publicAccess.console()))
})
