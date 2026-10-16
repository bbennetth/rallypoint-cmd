import { Hono } from 'hono'
import { wineInstallRequestSchema, wineStatusSchema, wineVersionsSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { LongOpConflictError } from '../services/long-op.js'
import { acquirePanelWide } from './panel-lock.js'

export const wineRoutes = new Hono<HonoApp>()

// Installed Wine loader, its WineHQ branch/version, and whether this CT
// can install WineHQ builds. Install progress streams over
// /api/panel/stream.
wineRoutes.get('/api/panel/wine', requireSession, async (c) => {
  const { wineUpdate } = c.get('composed')
  try {
    return c.json(wineStatusSchema.parse(await wineUpdate.status()))
  } catch (err) {
    throw errors.upstreamUnavailable(
      err instanceof Error ? `Wine check failed: ${err.message}` : 'Wine check failed',
    )
  }
})

// What the WineHQ repo offers per branch. ?refresh=1 re-downloads the
// WineHQ index first. No panel lock: it disturbs no server, and apt's own
// lock makes it fail cleanly (502 below) while an install holds apt.
wineRoutes.get('/api/panel/wine/versions', requireSession, async (c) => {
  const { wineUpdate } = c.get('composed')
  const refresh = c.req.query('refresh') === '1'
  try {
    return c.json(wineVersionsSchema.parse(await wineUpdate.versions({ refresh })))
  } catch (err) {
    throw errors.upstreamUnavailable(
      err instanceof Error ? `Wine version check failed: ${err.message}` : 'Wine version check failed',
    )
  }
})

// Install a WineHQ branch at a version (null = newest). apt replaces the
// loader binaries out from under any running Wine process, so every
// Windows-platform server must be stopped first, then the panel lock plus
// every instance's world lock keep this from interleaving with
// backups/restores/steamcmd on any server.
wineRoutes.post('/api/panel/wine/install', requireSession, async (c) => {
  const body = wineInstallRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  const composed = c.get('composed')
  const { wineUpdate, instances, longOps } = composed

  for (const inst of instances.list()) {
    if (inst.game.platform !== 'windows') continue
    const status = await inst.gameControl.status()
    if (status.activeState === 'active' || status.activeState === 'activating') {
      throw errors.conflict(
        'unit_active',
        `${inst.name} runs under Wine and is running — stop it before changing Wine.`,
      )
    }
  }

  const release = acquirePanelWide(composed, 'wine_update')
  try {
    const op = longOps.start('wine_update', async (sink) => {
      try {
        await wineUpdate.run(sink, body.data)
      } finally {
        release()
      }
    })
    return c.json(op, 202)
  } catch (err) {
    release()
    if (err instanceof LongOpConflictError) {
      throw errors.conflict('op_running', `A ${err.running.kind} operation is already running.`)
    }
    throw err
  }
})
