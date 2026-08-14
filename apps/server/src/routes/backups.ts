import fs from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { restoreRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { BackupError } from '../services/backup.js'
import { LongOpConflictError } from '../services/long-op.js'
import { requireCapability } from '../middleware/capability.js'

export const backupRoutes = new Hono<HonoApp>()

const backupsGate = requireCapability((g) => g.capabilities.world, 'backups')
backupRoutes.use('/backups', backupsGate)
backupRoutes.use('/backups/*', backupsGate)

function mapBackupError(err: unknown): never {
  if (err instanceof BackupError) {
    const status =
      err.code === 'not_found' || err.code === 'staging_missing'
        ? 404
        : err.code === 'too_large'
          ? 413
          : err.code === 'restore_failed'
            ? 500
            : err.code === 'no_world' || err.code === 'not_installed'
              ? 409
              : 400
    throw new ApiError({ code: err.code, message: err.message, status })
  }
  throw err
}

backupRoutes.get('/backups', requireSession, (c) => {
  const { backup } = c.get('services')
  return c.json({ backups: backup.list() })
})

// Manual backup — runs as a long-op (a large world can take a while to
// compress); progress streams over /api/updates/stream.
backupRoutes.post('/backups', requireSession, (c) => {
  const { backup, longOps, worldLock } = c.get('services')
  const release = worldLock.tryAcquire('backup:manual')
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${worldLock.holder ?? 'unknown'}).`,
    )
  }
  try {
    const op = longOps.start('backup', async (sink) => {
      try {
        await backup.create('manual', sink)
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

backupRoutes.get('/backups/:id/download', requireSession, (c) => {
  const { backup } = c.get('services')
  try {
    const { filePath, filename, sizeBytes } = backup.filePathFor(c.req.param('id'))
    const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>
    return c.body(stream, 200, {
      'content-type': 'application/gzip',
      'content-length': String(sizeBytes),
      'content-disposition': `attachment; filename="${filename}"`,
    })
  } catch (err) {
    mapBackupError(err)
  }
})

backupRoutes.delete('/backups/:id', requireSession, (c) => {
  const { backup } = c.get('services')
  try {
    backup.delete(c.req.param('id'))
    return c.json({ ok: true as const })
  } catch (err) {
    mapBackupError(err)
  }
})

// Raw streamed upload (application/gzip body, NOT multipart) — staged +
// validated, never applied here. Returns a RestorePreview.
backupRoutes.post('/backups/upload', requireSession, async (c) => {
  const { backup } = c.get('services')
  const body = c.req.raw.body
  if (!body) throw errors.validation({ reason: 'request body required' })
  try {
    const preview = await backup.stageUpload(body)
    return c.json(preview)
  } catch (err) {
    mapBackupError(err)
  }
})

// Apply a staged upload. Long-op with the world lock held; the typed
// confirmation is re-checked server-side.
backupRoutes.post('/backups/restore', requireSession, async (c) => {
  const { backup, longOps, worldLock } = c.get('services')
  const body = restoreRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })

  const release = worldLock.tryAcquire('restore')
  if (!release) {
    throw errors.conflict(
      'world_busy',
      `Another operation holds the world lock (${worldLock.holder ?? 'unknown'}).`,
    )
  }
  try {
    const op = longOps.start('restore', async (sink) => {
      try {
        await backup.restore(body.data.stagingId, body.data.confirm, sink)
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
    mapBackupError(err)
  }
})
