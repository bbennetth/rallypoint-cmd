import path from 'node:path'
import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  DEFAULT_SERVER_ID,
  createServerRequestSchema,
  gameBySlug,
  templateUnitFor,
  type GameServerSummary,
  type ServersResponse,
} from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { servers } from '../db/schema/index.js'

export const serverRoutes = new Hono<HonoApp>()

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
  const body: ServersResponse = {
    servers: summaries,
    defaultServerId: instances.getDefault().id,
  }
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

// Delete a server row (the seeded default is not deletable). Game files
// and backups on disk are left untouched — removal is an unregistration,
// not an uninstall.
serverRoutes.delete('/api/servers/:serverId', requireSession, (c) => {
  const { instances } = c.get('composed')
  const id = c.req.param('serverId')
  if (id === DEFAULT_SERVER_ID) {
    throw errors.conflict('default_server', 'The default server cannot be deleted.')
  }
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
