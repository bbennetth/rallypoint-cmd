import fs from 'node:fs'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { gameBySlug, panelStorageSchema, storageDeleteRequestSchema, templateUnitFor } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { backups } from '../db/schema/index.js'
import { ALLOWED_SLUGS } from '../services/constants.js'
import { dedupeDisks, dirSize, diskUsage } from '../services/disk.js'
import { createRealGameControl } from '../services/game-control.real.js'
import { LongOpConflictError } from '../services/long-op.js'
import {
  SAFE_ID,
  assertSafeChild,
  classifyBackupDirs,
  classifyGameDirs,
  deleteRefusal,
} from '../services/storage.js'

// Panel-level storage management: what sits under GAMES_ROOT/PANEL_BACKUP_DIR
// (server rows or not) and the destructive reclaim actions. Server
// deletion is an unregistration that leaves files behind — this is the
// only place the panel ever removes them. Deletes run on the panel
// LongOpRunner (progress over /api/panel/stream) while holding the
// instance's world lock when a row exists, the panel lock otherwise.

export const managementRoutes = new Hono<HonoApp>()

async function listDirNames(root: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    // Root missing (fresh install) reads as empty, same as statfs=null.
    return []
  }
}

managementRoutes.get('/api/panel/storage', requireSession, async (c) => {
  const env = c.get('env')
  const { instances } = c.get('composed')
  const rows = instances.list()

  const disks = dedupeDisks(
    (
      await Promise.all([diskUsage('games', env.GAMES_ROOT), diskUsage('backups', env.PANEL_BACKUP_DIR)])
    ).filter((d): d is NonNullable<typeof d> => d !== null),
  )

  const games = await Promise.all(
    classifyGameDirs(
      await listDirNames(env.GAMES_ROOT),
      rows.map((i) => ({ slug: i.game.slug, id: i.id, name: i.name })),
      ALLOWED_SLUGS,
    ).map(async (entry) => {
      const sizeBytes = await dirSize(path.join(env.GAMES_ROOT, entry.name))
      const inst = entry.serverId ? instances.get(entry.serverId) : undefined
      if (!inst) return { ...entry, sizeBytes }
      const status = await inst.gameControl.status()
      const running = status.activeState === 'active' || status.activeState === 'activating'
      return { ...entry, sizeBytes, running }
    }),
  )

  const backupDirs = await Promise.all(
    classifyBackupDirs(
      await listDirNames(env.PANEL_BACKUP_DIR),
      rows.map((i) => ({ id: i.id, name: i.name })),
    ).map(async (entry) => ({
      ...entry,
      sizeBytes: await dirSize(path.join(env.PANEL_BACKUP_DIR, entry.id)),
    })),
  )

  return c.json(panelStorageSchema.parse({ disks, games, backups: backupDirs }))
})

// The typed confirmation travels in the body and is re-checked here
// (restore precedent) — but the path is derived from the allowlisted
// route param, never from the body.
async function parseConfirm(c: Context<HonoApp>, expected: string): Promise<void> {
  const body = storageDeleteRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  if (body.data.confirm !== expected) {
    throw new ApiError({
      code: 'confirm_mismatch',
      message: 'Confirmation text did not match.',
      status: 400,
    })
  }
}

// Delete a game's install dir (registered or orphaned). The server row,
// its backups and its systemd unit are untouched — a registered server
// just drops to not_installed and can reinstall from its Updates tab.
managementRoutes.post('/api/panel/storage/games/:slug/delete', requireSession, async (c) => {
  const env = c.get('env')
  const logger = c.get('logger')
  const composed = c.get('composed')

  const slug = c.req.param('slug')
  const game = gameBySlug(slug)
  if (!game || !ALLOWED_SLUGS.includes(slug)) throw errors.notFound('Game directory')
  await parseConfirm(c, slug)

  const dir = assertSafeChild(env.GAMES_ROOT, slug)
  const inst = composed.instances.list().find((i) => i.game.slug === slug)

  // Lock before the unit check: a start clicked mid-delete then 409s on
  // this same lock (power.ts) instead of racing the rm.
  const lock = inst ? inst.worldLock : composed.worldLock
  const release = lock.tryAcquire('delete_game_files')
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${lock.holder ?? 'unknown'}).`,
    )
  }

  let op
  try {
    // Orphans have no instance; probe their unit one-shot. In mock mode
    // there is no systemd and fake state lives on instances, so an
    // orphan is inert by construction.
    const status = inst
      ? await inst.gameControl.status()
      : env.PANEL_MODE === 'mock'
        ? null
        : await createRealGameControl(env, logger, {
            unitName: templateUnitFor(slug),
            installDir: dir,
            installedProbe: game.installedProbe,
          }).status()
    const refusal = status ? deleteRefusal(status) : null
    if (refusal) {
      throw errors.conflict(
        refusal,
        refusal === 'unit_active'
          ? 'The game unit is running — stop it before deleting its files.'
          : 'Cannot determine whether the game is running (systemctl query failed) — refusing to delete its files.',
      )
    }
    op = composed.longOps.start('delete_game_files', async (sink) => {
      try {
        sink.line(`[panel] Deleting ${dir} ...`)
        await fs.promises.rm(dir, { recursive: true, force: true })
        sink.progress(100)
        sink.line('[panel] Game files deleted.')
        logger.info('game files deleted', { slug, dir })
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

// Delete a whole backup directory — a live server's (rows purged too, so
// the Backups tab never shows phantom entries) or an orphaned one left
// behind by server deletion. No unit guard: archives never touch live
// game files; the world lock is what excludes a concurrent backup/restore.
managementRoutes.post('/api/panel/storage/backups/:id/delete', requireSession, async (c) => {
  const env = c.get('env')
  const logger = c.get('logger')
  const db = c.get('db')
  const composed = c.get('composed')

  const id = c.req.param('id')
  if (!SAFE_ID.test(id)) throw errors.notFound('Backup directory')
  await parseConfirm(c, id)

  const dir = assertSafeChild(env.PANEL_BACKUP_DIR, id)
  const inst = composed.instances.get(id)
  if (!inst && !fs.existsSync(dir)) throw errors.notFound('Backup directory')

  const lock = inst ? inst.worldLock : composed.worldLock
  const release = lock.tryAcquire('delete_backup_dir')
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${lock.holder ?? 'unknown'}).`,
    )
  }

  let op
  try {
    op = composed.longOps.start('delete_backup_dir', async (sink) => {
      try {
        // Rows first: the Backups tab empties immediately, and an rm that
        // dies mid-way leaves a re-runnable orphan dir, not phantom rows.
        db.delete(backups).where(eq(backups.serverId, id)).run()
        sink.line(`[panel] Deleting ${dir} ...`)
        await fs.promises.rm(dir, { recursive: true, force: true })
        sink.progress(100)
        sink.line('[panel] Backup directory deleted.')
        logger.info('backup dir deleted', { id, dir })
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
