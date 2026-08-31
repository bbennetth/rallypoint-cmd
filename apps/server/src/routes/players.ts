import { Hono } from 'hono'
import {
  announceRequestSchema,
  kickBanRequestSchema,
  playerAdminFeatures,
  unbanRequestSchema,
  type PlayerAdminFeatures,
} from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { requireCapability } from '../middleware/capability.js'

export const playerRoutes = new Hono<HonoApp>()

// Whole area gated on the game exposing a player-admin channel. (Scoped
// to these paths — routers mounted at the same prefix share middleware.)
const playersGate = requireCapability((g) => g.capabilities.players !== 'none', 'player administration')
playerRoutes.use('/players', playersGate)
playerRoutes.use('/players/*', playersGate)
playerRoutes.use('/save', playersGate)

// Per-action gate: an admin channel may lack individual actions (Source
// games have no force-save, for example).
const featureGate = (feature: keyof PlayerAdminFeatures) =>
  requireCapability((g) => playerAdminFeatures(g)[feature], `player ${feature}`)

// Thin proxy over the game's admin channel (Palworld REST, RCON, telnet)
// — the browser never reaches it or sees its credentials. Upstream
// failures surface as 503.

function upstream(err: unknown): never {
  throw errors.upstreamUnavailable(err instanceof Error ? err.message : 'game admin API error')
}

playerRoutes.get('/players', requireSession, featureGate('list'), async (c) => {
  const { admin } = c.get('services')
  try {
    return c.json({ players: await admin.players() })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/announce', requireSession, featureGate('announce'), async (c) => {
  const { admin } = c.get('services')
  const body = announceRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await admin.announce(body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/kick', requireSession, featureGate('kick'), async (c) => {
  const { admin } = c.get('services')
  const body = kickBanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await admin.kick(body.data.userId, body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/ban', requireSession, featureGate('ban'), async (c) => {
  const { admin } = c.get('services')
  const body = kickBanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await admin.ban(body.data.userId, body.data.message)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/players/unban', requireSession, featureGate('unban'), async (c) => {
  const { admin } = c.get('services')
  const body = unbanRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    await admin.unban(body.data.userId)
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})

playerRoutes.post('/save', requireSession, featureGate('save'), async (c) => {
  const { admin } = c.get('services')
  try {
    await admin.save()
    return c.json({ ok: true as const })
  } catch (err) {
    upstream(err)
  }
})
