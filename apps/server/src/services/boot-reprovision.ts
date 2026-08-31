import { servers } from '../db/schema/index.js'
import type { Db } from '../db/client.js'
import type { Logger } from '../logger.js'
import type { UnitProvisioner } from './unit-provision.js'

// Re-renders every provisioned server's generated files at boot.
//
// start.sh and the instance drop-in are written only when a server is
// provisioned (create, or an explicit re-provision). That means a change
// to the templates in unit-provision.ts — the new WINEESYNC/WINEFSYNC
// exports, say — ships with a panel update but never reaches servers
// that were provisioned before it. Regenerating on every boot makes the
// generated files self-healing: whatever the current templates and the
// game registry say is what is on disk after a restart.
//
// The stored resource overrides are passed back through, otherwise the
// re-render would silently reset a user's memory/CPU limits to the
// registry defaults.
export async function reprovisionAllUnits(
  db: Db,
  provisioner: UnitProvisioner,
  logger: Logger,
): Promise<void> {
  const rows = db.select().from(servers).all()
  for (const row of rows) {
    try {
      await provisioner.provision(row.gameSlug, {
        memoryHigh: row.memoryHigh ?? null,
        memoryMax: row.memoryMax ?? null,
        cpuQuotaPct: row.cpuQuotaPct ?? null,
      })
    } catch (err) {
      // Never fatal: boot failures exit the process (server.ts), and one
      // broken server must not take the whole panel down with it.
      logger.warn('boot reprovision failed (continuing)', { slug: row.gameSlug, err })
    }
  }
}
