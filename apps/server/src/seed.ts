import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import type { Db } from './db/client.js'
import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { PasswordHasher } from './auth/password.js'
import { admins } from './db/schema/index.js'

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
