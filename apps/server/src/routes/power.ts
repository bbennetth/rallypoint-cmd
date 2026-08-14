import { Hono } from 'hono'
import { powerRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'

export const powerRoutes = new Hono<HonoApp>()

// start/stop/restart the game unit. Takes the world lock non-blocking:
// a backup/update/restore in flight answers 409 instead of interleaving.
powerRoutes.post('/power', requireSession, async (c) => {
  const { gameControl, worldLock } = c.get('services')
  const body = powerRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })

  const release = worldLock.tryAcquire(`power:${body.data.action}`)
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${worldLock.holder ?? 'unknown'}).`,
    )
  }
  try {
    const status = await gameControl.status()
    if (!status.installed) {
      const { game } = c.get('services').instance
      throw errors.conflict('not_installed', `${game.name} is not installed yet — run an install first.`)
    }
    c.get('logger').info('power action', { action: body.data.action })
    switch (body.data.action) {
      case 'start':
        await gameControl.start()
        break
      case 'stop':
        await gameControl.stop()
        break
      case 'restart':
        await gameControl.restart()
        break
    }
    // A (re)start picks up any pending ini edits.
    if (body.data.action !== 'stop') c.get('services').settings.clearPendingRestart()
    return c.json({ ok: true as const })
  } finally {
    release()
  }
})
