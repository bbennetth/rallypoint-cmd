import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Request-body ceilings for the JSON API. Every handler does
// `await c.req.json()`, which buffers the whole body before zod sees it,
// so without this an unauthenticated POST /api/auth/login (or a 50 MB
// `ServerName`) is limited only by Node's memory.
//
// hono's bodyLimit short-circuits on Content-Length and otherwise reads
// the stream up to maxSize (then replays it), throwing before the handler
// runs — so an oversized chunked body is a 413 too, never a 2xx.

// Ordinary JSON bodies: the largest legitimate one is a schedule with ten
// 600-char announce messages, far below this.
export const JSON_BODY_LIMIT_BYTES = 64 * 1024
// Settings: the raw editor accepts up to 1,000,000 chars of ini/cfg and
// JSON escaping can double that; the structured patch allows up to
// 500 x 4 KiB values.
export const SETTINGS_BODY_LIMIT_BYTES = 4 * 1024 * 1024

// Streaming uploads are exempt: the services enforce MAX_UPLOAD_BYTES on
// the stream themselves and report their own `too_large` codes.
const UPLOAD_ROUTE = /^\/api\/servers\/[^/]+\/(backups|mods)\/upload$/
const SETTINGS_ROUTE = /^\/api\/servers\/[^/]+\/settings(\/raw)?$/

function limiter(maxSize: number): MiddlewareHandler<HonoApp> {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw errors.payloadTooLarge(maxSize)
    },
  }) as MiddlewareHandler<HonoApp>
}

export function apiBodyLimit(): MiddlewareHandler<HonoApp> {
  const json = limiter(JSON_BODY_LIMIT_BYTES)
  const settings = limiter(SETTINGS_BODY_LIMIT_BYTES)
  return (c, next) => {
    const path = c.req.path
    if (UPLOAD_ROUTE.test(path)) return next()
    if (SETTINGS_ROUTE.test(path)) return settings(c, next)
    return json(c, next)
  }
}
