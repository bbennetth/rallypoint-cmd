import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import type { Db } from './db/client.js'
import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { PasswordHasher } from './auth/password.js'
import { admins, schedules, servers } from './db/schema/index.js'
import type { BackupPayload, RestartPayload } from '@rallypoint-cmd/shared'
import { DEFAULT_SERVER_ID, LEGACY_PALWORLD_UNIT } from '@rallypoint-cmd/shared'

// First-boot admin seeding: only when the admins table is empty. The
// provisioner passes PANEL_ADMIN_PASSWORD; dev prints a generated one.
export async function seedAdmin(
  db: Db,
  env: Env,
  hasher: PasswordHasher,
  logger: Logger,
): Promise<void> {
  const existing = db.select({ id: admins.id }).from(admins).limit(1).all()
  if (existing.length > 0) return

  const password = env.PANEL_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url')
  const { secretHash, keyVersion } = await hasher.hash(password)
  db.insert(admins)
    .values({ id: ulid(), username: env.PANEL_ADMIN_USERNAME, secretHash, keyVersion })
    .run()

  if (env.PANEL_ADMIN_PASSWORD) {
    logger.info('seeded admin user', { username: env.PANEL_ADMIN_USERNAME })
  } else {
    // Deliberately loud: this is the only time the generated password is
    // ever shown.
    logger.warn('seeded admin user with GENERATED password — change it after first login', {
      username: env.PANEL_ADMIN_USERNAME,
      password,
    })
  }
}

// Migration seed: every install gets a 'default' Palworld server row
// pointing at the legacy single-server layout (PAL_DIR +
// palworld.service). Pre-multigame backup/schedule rows carry
// server_id='default' via the column default, so this row adopting that
// id IS the whole data migration.
export function seedDefaultServer(db: Db, env: Env, logger: Logger): void {
  const existing = db.select({ id: servers.id }).from(servers).limit(1).all()
  if (existing.length > 0) return
  db.insert(servers)
    .values({
      id: DEFAULT_SERVER_ID,
      gameSlug: 'palworld',
      name: 'Palworld',
      installDir: env.PAL_DIR,
      unitName: LEGACY_PALWORLD_UNIT,
    })
    .run()
  logger.info('seeded default Palworld server row', { installDir: env.PAL_DIR })
}

// Default schedules seeded once, on first boot: a nightly restart (the
// standard mitigation for Palworld's memory leak) and a nightly backup.
// Enabled by default so a fresh install is safe out of the box.
export function seedDefaultSchedules(db: Db, logger: Logger): void {
  const existing = db.select({ id: schedules.id }).from(schedules).limit(1).all()
  if (existing.length > 0) return

  const restartPayload: RestartPayload = {
    saveBeforeStop: true,
    announceSteps: [
      { secondsBefore: 300, message: 'Server restart in 5 minutes.' },
      { secondsBefore: 60, message: 'Server restart in 1 minute — find a safe spot!' },
    ],
  }
  const backupPayload: BackupPayload = { retention: { keepLast: 14, keepDays: 30 } }

  db.insert(schedules)
    .values([
      {
        id: ulid(),
        kind: 'restart',
        cron: '0 5 * * *', // 05:00 daily
        timezone: 'UTC',
        enabled: true,
        payload: restartPayload,
      },
      {
        id: ulid(),
        kind: 'backup',
        cron: '30 4 * * *', // 04:30 daily, before the restart
        timezone: 'UTC',
        enabled: true,
        payload: backupPayload,
      },
    ])
    .run()
  logger.info('seeded default nightly restart + backup schedules')
}
