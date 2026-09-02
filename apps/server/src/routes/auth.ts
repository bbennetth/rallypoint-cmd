import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { and, eq, ne } from 'drizzle-orm'
import { changePasswordRequestSchema, loginRequestSchema } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import type { Env } from '../env.js'
import { errors } from '../errors.js'
import { generateSessionToken, hashToken } from '../auth/tokens.js'
import { admins, sessions } from '../db/schema/index.js'
import { requireSession } from '../middleware/session.js'
import { clientIp, rateLimit } from '../middleware/rate-limit.js'

export const authRoutes = new Hono<HonoApp>()

const LOGIN_WINDOW_MS = 10 * 60 * 1000

// Shared by set and delete: a __Host- cookie (COOKIE_SECURE) can only be
// serialized with Secure + Path=/, and hono throws otherwise — so the
// delete must carry the same attributes as the set or logout 500s.
function sessionCookieOptions(env: Env): {
  path: string
  httpOnly: boolean
  sameSite: 'Lax'
  secure: boolean
} {
  return { path: '/', httpOnly: true, sameSite: 'Lax', secure: env.COOKIE_SECURE }
}

authRoutes.post(
  '/api/auth/login',
  // Two buckets: per-IP (spray) and per-IP+username (targeted guessing).
  rateLimit({ bucket: 'login_ip', windowMs: LOGIN_WINDOW_MS, max: 30 }),
  rateLimit({
    bucket: 'login_user',
    windowMs: LOGIN_WINDOW_MS,
    max: 10,
    key: (c) => `${clientIp(c)}:u`,
  }),
  async (c) => {
    const env = c.get('env')
    const db = c.get('db')
    const hasher = c.get('passwordHasher')

    const body = loginRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw errors.validation({ issues: body.error.issues })

    const admin = db.select().from(admins).where(eq(admins.username, body.data.username)).get()
    if (!admin) {
      await hasher.dummyVerify() // equalize timing on unknown-username
      throw errors.loginInvalid()
    }
    const ok = await hasher.verify(admin.secretHash, admin.keyVersion, body.data.password)
    if (!ok) throw errors.loginInvalid()

    const token = generateSessionToken()
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    db.insert(sessions)
      .values({ idHash: hashToken(token), adminId: admin.id, absoluteExpiresAt: expiresAt })
      .run()

    setCookie(c, env.SESSION_COOKIE_NAME, token, {
      ...sessionCookieOptions(env),
      maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60,
    })
    c.get('logger').info('admin login', { username: admin.username, ip: clientIp(c) })
    return c.json({ username: admin.username, expiresAtMs: expiresAt.getTime() })
  },
)

authRoutes.get('/api/auth/session', requireSession, (c) => {
  const session = c.get('session')
  return c.json({ username: session.username, expiresAtMs: session.expiresAtMs })
})

authRoutes.post('/api/auth/logout', requireSession, (c) => {
  const env = c.get('env')
  const db = c.get('db')
  const session = c.get('session')
  // Clear the cookie first: if serialization throws, the row still exists
  // and a retry works, instead of a revoked row behind a lingering cookie.
  deleteCookie(c, env.SESSION_COOKIE_NAME, sessionCookieOptions(env))
  db.delete(sessions).where(eq(sessions.idHash, session.idHash)).run()
  return c.json({ ok: true as const })
})

authRoutes.post('/api/auth/change-password', requireSession, async (c) => {
  const db = c.get('db')
  const hasher = c.get('passwordHasher')
  const session = c.get('session')

  const body = changePasswordRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) throw errors.validation({ issues: body.error.issues })

  const admin = db.select().from(admins).where(eq(admins.id, session.adminId)).get()
  if (!admin) throw errors.sessionRequired()
  const ok = await hasher.verify(admin.secretHash, admin.keyVersion, body.data.currentPassword)
  if (!ok) throw errors.loginInvalid()

  const { secretHash, keyVersion } = await hasher.hash(body.data.newPassword)
  db.update(admins)
    .set({ secretHash, keyVersion, updatedAt: new Date() })
    .where(eq(admins.id, admin.id))
    .run()
  // Revoke every other session — a stolen cookie dies with the old password.
  db.delete(sessions)
    .where(and(eq(sessions.adminId, admin.id), ne(sessions.idHash, session.idHash)))
    .run()
  c.get('logger').info('admin password changed', { username: admin.username })
  return c.json({ ok: true as const })
})
