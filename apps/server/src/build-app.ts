import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Db } from './db/client.js'
import type { HonoApp } from './context.js'
import type { ComposedServices } from './services/compose.js'
import { createPasswordHasher, type PasswordHasher } from './auth/password.js'
import { requestId } from './middleware/request-id.js'
import { errorHandler } from './middleware/error-handler.js'
import { csrfIssueHandler, requireCsrf } from './middleware/csrf.js'
import { errors } from './errors.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { serverRoutes } from './routes/servers.js'
import { statusRoutes } from './routes/status.js'
import { metricsRoutes } from './routes/metrics.js'
import { powerRoutes } from './routes/power.js'
import { consoleRoutes } from './routes/console.js'
import { playerRoutes } from './routes/players.js'
import { updateRoutes } from './routes/updates.js'
import { settingsRoutes } from './routes/settings.js'
import { resourceRoutes } from './routes/resources.js'
import { backupRoutes } from './routes/backups.js'
import { modRoutes } from './routes/mods.js'
import { scheduleRoutes } from './routes/schedules.js'
import { panelUpdateRoutes } from './routes/panel-update.js'
import { publicAccessRoutes } from './routes/public-access.js'
import { managementRoutes } from './routes/management.js'
import { createSpaRoutes } from './routes/spa.js'
import fs from 'node:fs'

export interface BuildAppDeps {
  env: Env
  logger: Logger
  db: Db
  services: ComposedServices
  passwordHasher?: PasswordHasher
}

export function buildApp(deps: BuildAppDeps): Hono<HonoApp> {
  const composed = deps.services
  const passwordHasher =
    deps.passwordHasher ??
    createPasswordHasher({
      pepper: deps.env.PANEL_PASSWORD_PEPPER,
      pepperVersion: deps.env.PANEL_PEPPER_VERSION,
    })

  const app = new Hono<HonoApp>()

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
      ...(deps.env.COOKIE_SECURE
        ? { strictTransportSecurity: 'max-age=31536000; includeSubDomains' }
        : {}),
    }),
  )
  app.use('*', requestId)
  app.use('*', async (c, next) => {
    c.set('env', deps.env)
    c.set('logger', deps.logger)
    c.set('db', deps.db)
    c.set('composed', composed)
    c.set('passwordHasher', passwordHasher)
    // The per-instance `services` bag is set only on /api/servers/:serverId/*
    // (below). Panel-scoped routes read panel singletons from `composed`, so
    // the panel boots and serves fine with zero game servers.
    await next()
  })

  app.onError(errorHandler)

  // CSRF issuer (bare GET), then the double-submit check on every
  // state-changing /api/* request — including login.
  app.get('/api/csrf', csrfIssueHandler)
  app.use('/api/*', requireCsrf())

  // Panel-scoped routes (not tied to one game server).
  app.route('/', healthRoutes)
  app.route('/', authRoutes)
  app.route('/', serverRoutes)
  app.route('/', panelUpdateRoutes)
  app.route('/', publicAccessRoutes)
  app.route('/', managementRoutes)

  // Game-scoped routers, mounted under /api/servers/:serverId. The param
  // middleware resolves the instance and injects its `services` bag.
  const gameRouters = [
    statusRoutes,
    metricsRoutes,
    powerRoutes,
    consoleRoutes,
    playerRoutes,
    updateRoutes,
    settingsRoutes,
    resourceRoutes,
    backupRoutes,
    modRoutes,
    scheduleRoutes,
  ]

  app.use('/api/servers/:serverId/*', async (c, next) => {
    const id = c.req.param('serverId')
    const instance = id ? composed.instances.get(id) : undefined
    if (!instance) throw errors.notFound('Server')
    c.set('services', composed.servicesFor(instance))
    await next()
  })
  for (const r of gameRouters) {
    app.route('/api/servers/:serverId', r)
  }

  // Serve the built SPA in production (mounted last so it never shadows
  // /api or SSE). In dev this is unset and Vite serves the frontend.
  if (deps.env.WEB_DIST_DIR && fs.existsSync(deps.env.WEB_DIST_DIR)) {
    app.route('/', createSpaRoutes(deps.env.WEB_DIST_DIR))
  }

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404))

  return app
}
