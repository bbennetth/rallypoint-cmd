import { Hono } from 'hono'
import {
  announceRequestSchema,
  kickBanRequestSchema,
  unbanRequestSchema,
} from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { requireCapability } from '../middleware/capability.js'

export const playerRoutes = new Hono<HonoApp>()

// Whole area gated on the game exposing an admin/query API. (Scoped to
// these paths — routers mounted at the same prefix share middleware.)
const playersGate = requireCapability((g) => g.capabilities.query !== 'none', 'player administration')
playerRoutes.use('/players', playersGate)
playerRoutes.use('/players/*', playersGate)
playerRoutes.use('/save', playersGate)

// Thin proxy over the Palworld REST API — the browser never reaches
// 8212 or sees AdminPassword. Upstream failures surface as 503.

function upstream(err: unknown): never {
  throw errors.upstreamUnavailable(err instanceof Error ? err.message : 'Palworld REST API error')
}

playerRoutes.get('/players', requireSession, async (c) => {
  const { query } = c.get('services')
  try {
    return c.json({ players: await query.players() })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/announce', requireSession, async (c) => {
  const { query } = c.get('services')
  const body = announceRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await query.announce(body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/kick', requireSession, async (c) => {
  const { query } = c.get('services')
  const body = kickBanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await query.kick(body.data.userId, body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/ban', requireSession, async (c) => {
  const { query } = c.get('services')
  const body = kickBanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await query.ban(body.data.userId, body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/unban', requireSession, async (c) => {
  const { query } = c.get('services')
  const body = unbanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await query.unban(body.data.userId)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/save', requireSession, async (c) => {
  const { query } = c.get('services')
  try {
    await query.save()
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})
