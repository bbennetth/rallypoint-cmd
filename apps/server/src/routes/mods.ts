import { Hono } from 'hono'
import { modToggleRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { ModError } from '../services/mods.js'
import { requireCapability } from '../middleware/capability.js'

export const modRoutes = new Hono<HonoApp>()

const modsGate = requireCapability((g) => g.capabilities.mods !== 'none', 'mods')
modRoutes.use('/mods', modsGate)
modRoutes.use('/mods/*', modsGate)

function mapModError(err: unknown): never {
  if (err instanceof ModError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'too_large'
          ? 413
          : err.code === 'already_exists'
            ? 409
            : 400
    throw new ApiError({ code: err.code, message: err.message, status })
  }
  throw err
}

modRoutes.get('/mods', requireSession, (c) => {
  const { mods } = c.get('services')
  return c.json({ mods: mods.list() })
})

// Raw streamed upload (application/octet-stream body, NOT multipart) —
// the original filename rides in the query so the streaming byte-cap
// pattern stays identical to the backup upload. Fast fs work; no long-op.
modRoutes.post('/mods/upload', requireSession, async (c) => {
  const { mods } = c.get('services')
  const filename = c.req.query('filename') ?? ''
  if (!/\.(pak|zip)$/i.test(filename) || /[/\\]/.test(filename) || filename.length > 220) {
    throw new ApiError({
      code: 'invalid_filename',
      message: 'Only .pak files or .zip archives can be uploaded.',
      status: 400,
    })
  }
  const body = c.req.raw.body
  if (!body) throw errors.validation({ reason: 'request body required' })
  try {
    const { installed } = await mods.installFromUpload(body, filename)
    return c.json({ installed, mods: mods.list() })
  } catch (err) {
    mapModError(err)
  }
})

modRoutes.post('/mods/:id/toggle', requireSession, async (c) => {
  const { mods } = c.get('services')
  const body = modToggleRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    mods.setEnabled(c.req.param('id'), body.data.enabled)
    return c.json({ mods: mods.list() })
  } catch (err) {
    mapModError(err)
  }
})

modRoutes.delete('/mods/:id', requireSession, (c) => {
  const { mods } = c.get('services')
  try {
    mods.delete(c.req.param('id'))
    return c.json({ ok: true as const })
  } catch (err) {
    mapModError(err)
  }
})
