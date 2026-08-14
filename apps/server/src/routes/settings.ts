import { Hono } from 'hono'
import { rawSettingsSchema, settingsPatchSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { IniParseError } from '../services/settings-ini.js'
import { requireCapability } from '../middleware/capability.js'

export const settingsRoutes = new Hono<HonoApp>()

const settingsGate = requireCapability((g) => g.settingsAdapter !== 'none', 'panel-managed settings')
settingsRoutes.use('/settings', settingsGate)
settingsRoutes.use('/settings/*', settingsGate)

function mapIniError(err: unknown): never {
  if (err instanceof IniParseError) {
    throw new ApiError({ code: 'ini_invalid', message: err.message, status: 400 })
  }
  throw err
}

settingsRoutes.get('/settings', requireSession, (c) => {
  const { settings } = c.get('services')
  try {
    const { entries } = settings.read()
    return c.json({ entries, pendingRestart: settings.getPendingRestart() })
  } catch (err) {
    mapIniError(err)
  }
})

settingsRoutes.put('/settings', requireSession, async (c) => {
  const { settings } = c.get('services')
  const body = settingsPatchSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    settings.writeStructured(body.data.values)
  } catch (err) {
    mapIniError(err)
  }
  c.get('logger').info('settings updated', { keys: Object.keys(body.data.values) })
  return c.json({ ok: true as const, pendingRestart: true })
})

settingsRoutes.get('/settings/raw', requireSession, (c) => {
  const { settings } = c.get('services')
  try {
    return c.json({ content: settings.readRaw() })
  } catch (err) {
    mapIniError(err)
  }
})

settingsRoutes.put('/settings/raw', requireSession, async (c) => {
  const { settings } = c.get('services')
  const body = rawSettingsSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })
  try {
    settings.writeRaw(body.data.content)
  } catch (err) {
    mapIniError(err)
  }
  c.get('logger').info('settings raw-updated')
  return c.json({ ok: true as const, pendingRestart: true })
})
