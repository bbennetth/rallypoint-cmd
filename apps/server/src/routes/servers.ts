import path from 'node:path'
import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createServerRequestSchema,
  gameBySlug,
  templateUnitFor,
  type CreateScheduleRequest,
  type GameServerSummary,
  type ServersResponse,
} from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { servers } from '../db/schema/index.js'

export const serverRoutes = new Hono<HonoApp>()

// Sensible defaults every new server starts with: a nightly restart
// (memory-leak hygiene) and — for games the panel can back up — a nightly
// backup before it. Seeded per-server on create (there is no global seed).
function defaultSchedules(canBackup: boolean): CreateScheduleRequest[] {
  const restart: CreateScheduleRequest = {
    kind: 'restart',
    cron: '0 5 * * *', // 05:00 daily
    timezone: 'UTC',
    enabled: true,
    payload: {
      saveBeforeStop: true,
      announceSteps: [
        { secondsBefore: 300, message: 'Server restart in 5 minutes.' },
        { secondsBefore: 60, message: 'Server restart in 1 minute — find a safe spot!' },
      ],
    },
  }
  if (!canBackup) return [restart]
  const backup: CreateScheduleRequest = {
    kind: 'backup',
    cron: '30 4 * * *', // 04:30 daily, before the restart
    timezone: 'UTC',
    enabled: true,
    payload: { retention: { keepLast: 14, keepDays: 30 } },
  }
  return [backup, restart]
}

// List every managed server with a cheap status summary (systemd state +
// build id; no admin-API probe — the dashboard cards don't need it).
serverRoutes.get('/api/servers', requireSession, async (c) => {
  const { instances } = c.get('composed')
  const summaries: GameServerSummary[] = await Promise.all(
    instances.list().map(async (inst) => {
      const [systemd, buildId] = await Promise.all([
        inst.gameControl.status(),
        inst.steamcmd.installedBuildId(),
      ])
      const lifecycle = !systemd.installed
        ? ('not_installed' as const)
        : systemd.activeState === 'active'
          ? ('active' as const)
          : systemd.activeState === 'activating'
            ? ('activating' as const)
            : systemd.activeState === 'deactivating'
              ? ('deactivating' as const)
              : systemd.activeState === 'failed'
                ? ('failed' as const)
                : ('inactive' as const)
      return {
        id: inst.id,
        gameSlug: inst.game.slug,
        name: inst.name,
        unitName: inst.unitName,
        createdAtMs: 0,
        lifecycle,
        memoryCurrentBytes: systemd.memoryCurrentBytes,
        buildId,
      }
    }),
  )
  const body: ServersResponse = { servers: summaries }
  return c.json(body)
})

// Create a server: registers the row + instance. The actual game files
// arrive via the install long-op (POST .../updates/run kind=install);
// on a live host the systemd unit must be provisioned with
// `rallypoint-cmd-game add <slug>` (deploy/bin) before it can start.
serverRoutes.post('/api/servers', requireSession, async (c) => {
  const env = c.get('env')
  const { instances } = c.get('composed')
  const db = c.get('db')
  const body = createServerRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })

  const game = gameBySlug(body.data.gameSlug)
  if (!game) throw errors.validation({ reason: 'unknown game' })

  // One instance per game slug for now: install dir + unit name are both
  // derived from the slug and unique-constrained.
  if (instances.list().some((i) => i.game.slug === game.slug)) {
    throw errors.conflict('server_exists', `A ${game.name} server already exists.`)
  }

  const row = {
    id: ulid().toLowerCase(),
    gameSlug: game.slug,
    name: body.data.name,
    installDir: path.join(env.GAMES_ROOT, game.slug),
    unitName: templateUnitFor(game.slug),
  }
  db.insert(servers).values(row).run()
  const inserted = db.select().from(servers).all().find((r) => r.id === row.id)!
  const inst = instances.add(inserted)
  // Seed this server's default nightly schedules (backup only when the
  // game supports it).
  for (const req of defaultSchedules(game.capabilities.world)) {
    c.get('composed').scheduler.create(inst.id, req)
  }
  c.get('logger').info('server created', { id: inst.id, game: game.slug })
  return c.json(
    {
      id: inst.id,
      gameSlug: inst.game.slug,
      name: inst.name,
      unitName: inst.unitName,
      createdAtMs: inserted.createdAt.getTime(),
    },
    201,
  )
})

// Delete a server row. Game files and backups on disk are left untouched
// — removal is an unregistration, not an uninstall.
serverRoutes.delete('/api/servers/:serverId', requireSession, (c) => {
  const { instances } = c.get('composed')
  const id = c.req.param('serverId')
  const inst = instances.get(id)
  if (!inst) throw errors.notFound('Server')
  const release = inst.worldLock.tryAcquire('delete')
  if (!release) {
    throw errors.conflict('world_busy', 'An operation is running on this server.')
  }
  try {
    instances.remove(id)
  } finally {
    release()
  }
  c.get('logger').info('server deleted', { id })
  return c.json({ ok: true as const })
})
