import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { rateLimits } from '../db/schema/index.js'

// Fixed-window rate limiting backed by SQLite (mirrors id-api's
// rate_limits pattern). Good enough for a single-admin panel — the goal
// is stopping online password guessing, not absorbing DDoS.

export function clientIp(c: Context<HonoApp>): string {
  const env = c.get('env')
  if (env.TRUSTED_PROXY) {
    // Behind a trusted reverse proxy: use the forwarded client IP. Take
    // the LAST X-Forwarded-For entry — that is the peer address the proxy
    // in front of us appended; everything before it arrived in the
    // request and is attacker-controlled (a rotating first entry would
    // otherwise give every login attempt its own rate-limit bucket).
    // Requires the proxy to append (nginx: $proxy_add_x_forwarded_for),
    // which Caddy, Traefik and Cloudflare do by default.
    // cf-connecting-ip is accepted as a fallback.
    const fwd = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
    if (fwd) return fwd
    const cf = c.req.header('cf-connecting-ip')
    if (cf) return cf
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function rateLimit(config: {
  bucket: string
  windowMs: number
  max: number
  key?: (c: Context<HonoApp>) => string
}): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const db = c.get('db')
    const key = config.key ? config.key(c) : clientIp(c)
    const now = Date.now()
    const windowStart = now - (now % config.windowMs)

    // Lazily reset rows from previous windows, then upsert-increment.
    db.delete(rateLimits)
      .where(and(eq(rateLimits.bucket, config.bucket), lt(rateLimits.windowStartMs, windowStart)))
      .run()
    db.insert(rateLimits)
      .values({ bucket: config.bucket, key, windowStartMs: windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.bucket, rateLimits.key],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .run()
    const row = db
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(and(eq(rateLimits.bucket, config.bucket), eq(rateLimits.key, key)))
      .get()

    if (row && row.count > config.max) {
      const retryAfter = Math.ceil((windowStart + config.windowMs - now) / 1000)
      throw errors.rateLimited(retryAfter, config.bucket)
    }
    await next()
  }
}
