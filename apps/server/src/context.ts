import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Db } from './db/client.js'
import type { Services } from './services/types.js'
import type { ComposedServices } from './services/compose.js'
import type { PasswordHasher } from './auth/password.js'

export interface SessionCtx {
  adminId: string
  username: string
  idHash: string
  expiresAtMs: number
}

// Hono context variables, set once per request in build-app.ts.
export interface HonoApp {
  Variables: {
    env: Env
    logger: Logger
    db: Db
    // The composition root (instance manager + panel singletons).
    composed: ComposedServices
    // Request-scoped bag: the resolved server instance's services (the
    // default server on legacy unprefixed paths).
    services: Services
    passwordHasher: PasswordHasher
    requestId: string
    session: SessionCtx
  }
}
