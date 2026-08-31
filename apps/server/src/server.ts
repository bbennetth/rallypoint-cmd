import { serve } from '@hono/node-server'
import { parseEnv } from './env.js'
import { buildLogger } from './logger.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { composeServices } from './services/compose.js'
import { reprovisionAllUnits } from './services/boot-reprovision.js'
import { createPasswordHasher } from './auth/password.js'
import { buildApp } from './build-app.js'
import { seedAdmin } from './seed.js'

async function main(): Promise<void> {
  const env = parseEnv(process.env)
  const logger = buildLogger(env.NODE_ENV === 'development' ? 'debug' : 'info')

  const { db, sqlite } = createDb(env.DB_PATH)
  runMigrations(db)

  const passwordHasher = createPasswordHasher({
    pepper: env.PANEL_PASSWORD_PEPPER,
    pepperVersion: env.PANEL_PEPPER_VERSION,
  })
  await seedAdmin(db, env, passwordHasher, logger)

  const services = composeServices(env, logger, db)
  services.scheduler.start()
  // Regenerate start.sh / drop-ins so template changes reach servers
  // provisioned by an older panel version.
  await reprovisionAllUnits(db, services.unitProvisioner, logger)
  const app = buildApp({ env, logger, db, services, passwordHasher })

  const server = serve({ fetch: app.fetch, hostname: env.PANEL_HOST, port: env.PANEL_PORT }, (info) => {
    logger.info('panel listening', {
      host: env.PANEL_HOST,
      port: info.port,
      mode: env.PANEL_MODE,
      version: env.PANEL_VERSION,
    })
  })

  const shutdown = (): void => {
    logger.info('shutting down')
    services.dispose()
    server.close(() => {
      sqlite.close()
      process.exit(0)
    })
    // Hard exit if close hangs (open SSE streams).
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error('fatal boot error', err)
  process.exit(1)
})
