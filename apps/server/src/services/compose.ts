import { eq } from 'drizzle-orm'
import { gameBySlug } from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { Db } from '../db/client.js'
import { backups, schedules, servers, type ServerRow } from '../db/schema/index.js'
import type { SchedulerService } from './scheduler.js'
import type { PanelUpdateService } from './panel-update.js'
import type { PublicAccessService } from './public-access.js'
import type { ServerInstance, Services } from './types.js'
import { LongOpRunner } from './long-op.js'
import { WorldLock } from './world-lock.js'
import { createFakeInstanceServices } from './fake/index.js'
import { createRealGameControl } from './game-control.real.js'
import { createRealJournal } from './journal.real.js'
import { createRealPalRest } from './pal-rest.real.js'
import { createRealSteamCmd } from './steamcmd.real.js'
import { createSettingsService } from './settings-ini.js'
import { createBackupService } from './backup.js'
import { createModsService } from './mods.js'
import { createScheduler } from './scheduler.js'
import { createFakePanelUpdate, createRealPanelUpdate } from './panel-update.js'
import { createFakePublicAccess, createRealPublicAccess } from './public-access.js'
import { createFakeUnitProvisioner, createRealUnitProvisioner, type UnitProvisioner } from './unit-provision.js'
import { createNullBackup, createNullMods, createNullQuery, createNullSettings } from './stubs.js'
import path from 'node:path'

// Composition root: one set of instance services per managed server row
// (real vs fake picked by PANEL_MODE), plus panel-level singletons.
// LongOpRunner and WorldLock are always real, per instance — they're
// pure in-process coordination.

export interface InstanceManager {
  list(): ServerInstance[]
  get(id: string): ServerInstance | undefined
  // Register a freshly-inserted server row.
  add(row: ServerRow): ServerInstance
  remove(id: string): void
}

export interface ComposedServices {
  instances: InstanceManager
  scheduler: SchedulerService
  panelUpdate: PanelUpdateService
  publicAccess: PublicAccessService
  // Provisions/deprovisions the systemd unit (start.sh + drop-in) for a
  // game slug via the sudoers-pinned root helper.
  unitProvisioner: UnitProvisioner
  // Panel-level coordination for panel-scoped long-ops (self-update,
  // public access) — independent of any game server, so these keep
  // working when zero servers exist. Progress streams over /api/panel/stream.
  longOps: LongOpRunner
  worldLock: WorldLock
  // Request-scoped bag for handlers, built around one resolved instance.
  servicesFor(instance: ServerInstance): Services
  dispose(): void
}

export function composeServices(env: Env, logger: Logger, db: Db): ComposedServices {
  function createInstance(row: ServerRow): ServerInstance {
    const game = gameBySlug(row.gameSlug)
    if (!game) throw new Error(`server ${row.id} references unknown game slug ${row.gameSlug}`)
    const longOps = new LongOpRunner()
    const worldLock = new WorldLock()

    // Per-server pending-restart flag + backup subdir, namespaced by id.
    const stateKey = `pendingRestart:${row.id}`
    const backupDir = path.join(env.BACKUP_DIR, row.id)

    // Settings/mods are always the real fs implementations — in mock
    // mode they just operate on the sandbox dirs.
    const settings =
      game.settingsAdapter === 'palworld-ini'
        ? createSettingsService(env, db, {
            installDir: row.installDir,
            stateKey,
            restPort: game.ports.find((p) => p.name === 'rest')?.port ?? 8212,
          })
        : createNullSettings(db, game, stateKey)
    const mods =
      game.capabilities.mods === 'ue-paks'
        ? createModsService(env, logger, row.installDir)
        : createNullMods(game)

    const base =
      env.PANEL_MODE === 'mock'
        ? createFakeInstanceServices(env, logger, row.installDir, game)
        : (() => {
            const journal = createRealJournal(logger, row.unitName)
            journal.start()
            return {
              gameControl: createRealGameControl(env, logger, {
                unitName: row.unitName,
                installDir: row.installDir,
                installedProbe: game.installedProbe,
              }),
              query:
                game.capabilities.query === 'pal-rest'
                  ? createRealPalRest(logger, row.installDir)
                  : createNullQuery(game),
              journal,
              steamcmd: createRealSteamCmd(env, logger, {
                steamAppId: game.steamAppId,
                installDir: row.installDir,
              }),
              dispose: () => journal.stop(),
            }
          })()

    const backup = game.capabilities.world
      ? createBackupService({
          env,
          db,
          logger,
          gameControl: base.gameControl,
          query: base.query,
          steamcmd: base.steamcmd,
          settings,
          serverId: row.id,
          installDir: row.installDir,
          backupDir,
        })
      : createNullBackup(game)
    backup.pruneStaging()

    return {
      id: row.id,
      name: row.name,
      installDir: row.installDir,
      unitName: row.unitName,
      game,
      gameControl: base.gameControl,
      query: base.query,
      journal: base.journal,
      steamcmd: base.steamcmd,
      settings,
      backup,
      mods,
      longOps,
      worldLock,
      dispose: () => base.dispose(),
    }
  }

  const instanceMap = new Map<string, ServerInstance>()
  for (const row of db.select().from(servers).all()) {
    instanceMap.set(row.id, createInstance(row))
  }

  const instances: InstanceManager = {
    list: () => [...instanceMap.values()],
    get: (id) => instanceMap.get(id),
    add: (row) => {
      const inst = createInstance(row)
      instanceMap.set(row.id, inst)
      return inst
    },
    remove: (id) => {
      const inst = instanceMap.get(id)
      if (!inst) return
      inst.dispose()
      instanceMap.delete(id)
      // Drop dependent rows first (schedule_runs cascade off schedules);
      // any still-registered cron job no-ops once its row is gone.
      db.delete(schedules).where(eq(schedules.serverId, id)).run()
      db.delete(backups).where(eq(backups.serverId, id)).run()
      db.delete(servers).where(eq(servers.id, id)).run()
    },
  }

  const scheduler = createScheduler({ env, db, logger, getInstance: (id) => instanceMap.get(id) })
  const panelUpdate = env.PANEL_MODE === 'mock' ? createFakePanelUpdate(env) : createRealPanelUpdate({ env, db, logger })
  const publicAccess =
    env.PANEL_MODE === 'mock' ? createFakePublicAccess() : createRealPublicAccess({ db, logger, instances })
  const unitProvisioner =
    env.PANEL_MODE === 'mock' ? createFakeUnitProvisioner(logger) : createRealUnitProvisioner(logger)
  // Panel-scoped coordination (self-update + public access), independent
  // of any game server.
  const panelLongOps = new LongOpRunner()
  const panelWorldLock = new WorldLock()

  return {
    instances,
    scheduler,
    panelUpdate,
    publicAccess,
    unitProvisioner,
    longOps: panelLongOps,
    worldLock: panelWorldLock,
    servicesFor: (instance) => ({
      instance,
      gameControl: instance.gameControl,
      query: instance.query,
      journal: instance.journal,
      steamcmd: instance.steamcmd,
      longOps: instance.longOps,
      worldLock: instance.worldLock,
      settings: instance.settings,
      backup: instance.backup,
      mods: instance.mods,
      scheduler,
      panelUpdate,
      publicAccess,
    }),
    dispose: () => {
      scheduler.stop()
      for (const inst of instanceMap.values()) inst.dispose()
    },
  }
}
