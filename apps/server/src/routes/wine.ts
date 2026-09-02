import { Hono } from 'hono'
import { wineStatusSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { LongOpConflictError } from '../services/long-op.js'
import { acquirePanelWide } from './panel-lock.js'

export const wineRoutes = new Hono<HonoApp>()

// Installed Wine loader + whether this CT can be upgraded to WineHQ
// staging. Progress for the upgrade streams over /api/panel/stream.
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

// Upgrade Debian wine -> WineHQ staging. apt replaces the loader binaries
// out from under any running Wine process, so every Windows-platform
// server must be stopped first (management.ts' unit_active refusal), then
// the panel lock plus every instance's world lock keep this from
// interleaving with backups/restores/steamcmd on any server.
wineRoutes.post('/api/panel/wine/upgrade', requireSession, async (c) => {
  const composed = c.get('composed')
  const { wineUpdate, instances, longOps } = composed

  for (const inst of instances.list()) {
    if (inst.game.platform !== 'windows') continue
    const status = await inst.gameControl.status()
    if (status.activeState === 'active' || status.activeState === 'activating') {
      throw errors.conflict(
        'unit_active',
        `${inst.name} runs under Wine and is running — stop it before upgrading Wine.`,
      )
    }
  }

  const release = acquirePanelWide(composed, 'wine_update')
  try {
    const op = longOps.start('wine_update', async (sink) => {
      try {
        await wineUpdate.run(sink)
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
