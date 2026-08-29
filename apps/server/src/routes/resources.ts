import os from 'node:os'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  effectiveResources,
  parseSystemdBytes,
  resourcesPatchSchema,
  validateEffectiveResources,
  type ResourceOverrides,
} from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { servers } from '../db/schema/index.js'

// Per-server resource limits (memory caps + CPU quota) layered over the
// registry defaults. No capability gate — every game runs under a
// systemd unit, so every game can be given limits. A save rewrites the
// unit's drop-in via the (idempotent) provisioner and raises the
// pending-restart flag; applying it is the existing power/restart flow.

export const resourceRoutes = new Hono<HonoApp>()

function hostCeilings(): { cpus: number; memBytes: number } {
  return { cpus: Math.max(1, os.cpus().length), memBytes: os.totalmem() }
}

function defaultsFor(game: { memoryHigh?: string; memoryMax?: string }) {
  return {
    memoryHigh: game.memoryHigh ?? null,
    memoryMax: game.memoryMax ?? null,
    cpuQuotaPct: null,
  }
}

resourceRoutes.get('/resources', requireSession, (c) => {
  const { instance, settings } = c.get('services')
  const overrides = instance.getResourceOverrides()
  return c.json({
    overrides,
    defaults: defaultsFor(instance.game),
    effective: effectiveResources(instance.game, overrides),
    host: hostCeilings(),
    pendingRestart: settings.getPendingRestart(),
  })
})

resourceRoutes.put('/resources', requireSession, async (c) => {
  const { instance, settings } = c.get('services')
  const body = resourcesPatchSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })

  const current = instance.getResourceOverrides()
  const next: ResourceOverrides = {
    memoryHigh: body.data.memoryHigh !== undefined ? body.data.memoryHigh : current.memoryHigh,
    memoryMax: body.data.memoryMax !== undefined ? body.data.memoryMax : current.memoryMax,
    cpuQuotaPct: body.data.cpuQuotaPct !== undefined ? body.data.cpuQuotaPct : current.cpuQuotaPct,
  }

  const host = hostCeilings()
  const effective = effectiveResources(instance.game, next)
  const crossFieldError = validateEffectiveResources(effective)
  if (crossFieldError) {
    throw new ApiError({ code: 'validation_failed', message: crossFieldError, status: 400 })
  }
  if (next.cpuQuotaPct !== null && next.cpuQuotaPct > host.cpus * 100) {
    throw new ApiError({
      code: 'validation_failed',
      message: `CPU quota exceeds host capacity (${host.cpus} cores = ${host.cpus * 100}%).`,
      status: 400,
    })
  }
  for (const [label, value] of [
    ['MemoryHigh', next.memoryHigh],
    ['MemoryMax', next.memoryMax],
  ] as const) {
    const bytes = parseSystemdBytes(value ?? undefined)
    if (bytes !== null && bytes > host.memBytes) {
      throw new ApiError({
        code: 'validation_failed',
        message: `${label} (${value}) exceeds host memory.`,
        status: 400,
      })
    }
  }

  c.get('db')
    .update(servers)
    .set({ memoryHigh: next.memoryHigh, memoryMax: next.memoryMax, cpuQuotaPct: next.cpuQuotaPct })
    .where(eq(servers.id, instance.id))
    .run()
  instance.setResourceOverrides(next)
  // Rewrites the drop-in and daemon-reloads. If this throws after the DB
  // write, the row is already saved and the next successful save (or
  // server re-create) re-renders the same values — no divergence sticks.
  await c.get('composed').unitProvisioner.provision(instance.game.slug, next)
  settings.markPendingRestart()

  c.get('logger').info('resource limits updated', { serverId: instance.id, overrides: next })
  return c.json({ ok: true as const, pendingRestart: true as const })
})
