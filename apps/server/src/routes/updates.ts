import { Hono } from 'hono'
import type { UpdateState } from '@rallypoint-cmd/shared'
import { updateRunRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { LongOpConflictError } from '../services/long-op.js'
import { assertDiskFloor } from '../services/disk.js'
import { streamLongOp } from './long-op-stream.js'

// A game update can pull multiple GiB; be conservative.
const PROJECTED_UPDATE_BYTES = 4 * 1024 ** 3

export const updateRoutes = new Hono<HonoApp>()

updateRoutes.get('/updates', requireSession, async (c) => {
  const { longOps, steamcmd } = c.get('services')
  const state: UpdateState = {
    op: longOps.current(),
    installedBuildId: await steamcmd.installedBuildId(),
  }
  return c.json(state)
})

// Kick off a SteamCMD run. The op holds the world lock for its whole
// lifetime; updating under a live server corrupts files, so the game is
// stopped first and restarted after iff it was running.
updateRoutes.post('/updates/run', requireSession, async (c) => {
  const env = c.get('env')
  const logger = c.get('logger')
  const { instance, gameControl, steamcmd, longOps, worldLock, settings } = c.get('services')

  const body = updateRunRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  const kind = body.data.kind

  const release = worldLock.tryAcquire(`steamcmd:${kind}`)
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${worldLock.holder ?? 'unknown'}).`,
    )
  }

  try {
    await assertDiskFloor(instance.installDir, PROJECTED_UPDATE_BYTES, env.DISK_FLOOR_BYTES)
  } catch (err) {
    release()
    throw errors.conflict('disk_full', err instanceof Error ? err.message : 'Disk floor check failed')
  }

  let op
  try {
    op = longOps.start(kind, async (sink) => {
      try {
        const status = await gameControl.status()
        const wasActive = status.activeState === 'active' || status.activeState === 'activating'
        if (wasActive) {
          sink.line(`[panel] Stopping ${instance.unitName} before SteamCMD run...`)
          await gameControl.stop()
          const stopped = await gameControl.waitFor('inactive', 120_000)
          if (!stopped) throw new Error('game did not stop within 120s; aborting update')
        }
        await steamcmd.run(kind, sink)
        // SteamCMD can self-update and exit on its very first run without
        // actually installing the app. Verify the install really landed so
        // "install succeeded but nothing's there" surfaces as a failure.
        if (kind === 'install' && (await steamcmd.installedBuildId()) === null) {
          throw new Error(
            'SteamCMD finished but the server is still not installed (it may have self-updated first). Run install again.',
          )
        }
        // Fresh install: seed a REST-enabled settings file if the game
        // needs one and has none yet (no-op otherwise), so the panel can
        // talk to it on first start.
        if (kind === 'install') {
          try {
            settings.seedIfMissing()
            sink.line('[panel] Seeded server settings (panel-managed admin access enabled).')
          } catch (err) {
            sink.line(
              `[panel] Could not seed settings automatically: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (wasActive) {
          sink.line(`[panel] SteamCMD finished — starting ${instance.unitName}...`)
          await gameControl.start()
          settings.clearPendingRestart()
        }
        logger.info('steamcmd op finished', { kind, server: instance.id })
      } finally {
        release()
      }
    })
  } catch (err) {
    release()
    if (err instanceof LongOpConflictError) {
      throw errors.conflict('op_running', `A ${err.running.kind} operation is already running.`)
    }
    throw err
  }
  return c.json(op, 202)
})

// SSE progress stream: replays the op's line buffer then live lines,
// progress percentages, and the final done event (this instance's ops).
updateRoutes.get('/updates/stream', requireSession, (c) => {
  return streamLongOp(c, c.get('services').longOps)
})
