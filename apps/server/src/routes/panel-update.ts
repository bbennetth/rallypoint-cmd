import { Hono } from 'hono'
import { panelOpStateSchema, panelUpdateInfoSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { LongOpConflictError } from '../services/long-op.js'
import { streamLongOp } from './long-op-stream.js'

export const panelUpdateRoutes = new Hono<HonoApp>()

// Panel-scoped SSE progress stream (self-update + public-access ops run on
// the panel-level LongOpRunner, independent of any game server).
panelUpdateRoutes.get('/api/panel/stream', requireSession, (c) => {
  return streamLongOp(c, c.get('composed').longOps)
})

// Currently- or last-run op on the panel-level runner (panel_update,
// public_access, storage deletes). The per-server /updates state can't
// answer this — panel ops never run on an instance's runner.
panelUpdateRoutes.get('/api/panel/op', requireSession, (c) => {
  return c.json(panelOpStateSchema.parse({ op: c.get('composed').longOps.current() }))
})

// Current version + (cached, daily) latest-release check. ?force=1 hits
// the GitHub API now.
panelUpdateRoutes.get('/api/panel/update', requireSession, async (c) => {
  const { panelUpdate } = c.get('composed')
  try {
    const info = await panelUpdate.info(c.req.query('force') === '1')
    return c.json(panelUpdateInfoSchema.parse(info))
  } catch (err) {
    throw errors.upstreamUnavailable(
      err instanceof Error ? `Update check failed: ${err.message}` : 'Update check failed',
    )
  }
})

// Apply the latest release. Runs as a long-op streaming over
// /api/updates/stream; takes the world lock so it can't interleave with
// backups/restores/steamcmd. The service restart kills the panel mid-op —
// the UI polls /api/health until the new version answers.
panelUpdateRoutes.post('/api/panel/update/run', requireSession, (c) => {
  const { panelUpdate, longOps, worldLock } = c.get('composed')
  const release = worldLock.tryAcquire('panel_update')
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${worldLock.holder ?? 'unknown'}).`,
    )
  }
  try {
    const op = longOps.start('panel_update', async (sink) => {
      try {
        await panelUpdate.run(sink)
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
