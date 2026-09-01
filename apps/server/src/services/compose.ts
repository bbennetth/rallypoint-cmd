import { eq } from 'drizzle-orm'
import { gameBySlug, type ResourceOverrides } from '@rallypoint-cmd/shared'
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
import { createRealMetricsSampler } from './metrics.real.js'
import { createRealPalRest } from './pal-rest.real.js'
import { createA2sQuery } from './a2s.real.js'
import { createRealSteamCmd } from './steamcmd.real.js'
import { createSettingsService } from './settings-ini.js'
import { createEnshroudedSettings } from './settings-json.js'
import { createSettingsFor, launchConfConfigFor } from './game-settings-configs.js'
import { createFileSettings } from './settings-file.js'
import { createSatisfactoryQuery } from './satisfactory-lwq.real.js'
import { readAdminCreds } from './admin-creds.js'
import { createRconAdmin } from './admin/rcon-admin.js'
import { createRustWebrcon } from './admin/rust-webrcon.js'
import { create7dtdTelnet } from './admin/telnet-7dtd.js'
import { createBackupService } from './backup.js'
import { contractFor } from './backup-contracts.js'
import { createModsService } from './mods.js'
import { createScheduler } from './scheduler.js'
import { createFakePanelUpdate, createRealPanelUpdate } from './panel-update.js'
import { createFakePublicAccess, createRealPublicAccess } from './public-access.js'
import { createFakeUnitProvisioner, createRealUnitProvisioner, type UnitProvisioner } from './unit-provision.js'
import { createNullAdmin, createNullBackup, createNullMods, createNullQuery, createNullSettings } from './stubs.js'
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
  // game slug, rendered from the game registry.
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

// A named port the registry promises exists. Missing means the registry
// entry and the capability it declares have drifted apart — fail loudly
// at startup rather than quietly querying port 0 forever.
function portFor(game: { slug: string; ports: { name: string; port: number }[] }, name: string): number {
  const port = game.ports.find((p) => p.name === name)?.port
  if (!port) throw new Error(`${game.slug} declares no '${name}' port but its capabilities need one`)
  return port
}

export function composeServices(env: Env, logger: Logger, db: Db): ComposedServices {
  function createInstance(row: ServerRow): ServerInstance {
    const game = gameBySlug(row.gameSlug)
    if (!game) throw new Error(`server ${row.id} references unknown game slug ${row.gameSlug}`)
    const longOps = new LongOpRunner()
    const worldLock = new WorldLock()

    // In-memory copy of the row's resource overrides, mutated when the
    // resources route saves — the metrics samplers read it per snapshot,
    // so new ceilings show up without a panel restart.
    let resourceOverrides: ResourceOverrides = {
      memoryHigh: row.memoryHigh ?? null,
      memoryMax: row.memoryMax ?? null,
      cpuQuotaPct: row.cpuQuotaPct ?? null,
    }
    const getResourceOverrides = (): ResourceOverrides => resourceOverrides

    // Per-server pending-restart flag + backup subdir, namespaced by id.
    const stateKey = `pendingRestart:${row.id}`
    const backupDir = path.join(env.PANEL_BACKUP_DIR, row.id)

    // Settings/mods are always the real fs implementations — in mock
    // mode they just operate on the sandbox dirs.
    const settings =
      game.settingsAdapter === 'palworld-ini'
        ? createSettingsService(env, db, {
            installDir: row.installDir,
            stateKey,
            restPort: game.ports.find((p) => p.name === 'rest')?.port ?? 8212,
          })
        : game.settingsAdapter === 'enshrouded-json'
          ? createEnshroudedSettings(env, db, {
              installDir: row.installDir,
              stateKey,
              gamePort: game.ports.find((p) => p.name === 'game')?.port ?? 15636,
              queryPort: game.ports.find((p) => p.name === 'query')?.port ?? 15637,
            })
          : (createSettingsFor(env, db, game, { installDir: row.installDir, stateKey }) ??
            createNullSettings(db, game, stateKey))
    // start.sh dot-sources the launch conf, so it has to exist before the
    // game can start with the args the panel intends. Seeding here (not
    // just after an install) covers servers that predate the conf, and is
    // idempotent — a conf already satisfying its invariants is untouched.
    if (game.launchConfFile) {
      // Rust and CS2 keep their admin credentials on the command line, so
      // they carry a second, panel-owned conf beside their settings file;
      // for Valheim the conf *is* the settings file.
      const launchConf = launchConfConfigFor(game)
      const service = launchConf
        ? createFileSettings(env, db, launchConf, { installDir: row.installDir, stateKey })
        : settings
      try {
        service.seedIfMissing()
      } catch (err) {
        logger.warn('could not seed launch conf', {
          server: row.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const mods =
      game.capabilities.mods === 'ue-paks'
        ? createModsService(env, logger, row.installDir)
        : createNullMods(game)

    const base =
      env.PANEL_MODE === 'mock'
        ? createFakeInstanceServices(env, logger, row.installDir, game, getResourceOverrides)
        : (() => {
            const journal = createRealJournal(logger, row.unitName)
            journal.start()
            // Palworld's REST client serves both the read-side query and
            // the admin channel — one instance wired into both slots.
            const palRest =
              game.capabilities.query === 'pal-rest' || game.capabilities.players === 'pal-rest'
                ? createRealPalRest(logger, row.installDir)
                : null
            const query =
              palRest ??
              (game.capabilities.query === 'a2s'
                ? createA2sQuery(portFor(game, 'query'))
                : game.capabilities.query === 'satisfactory-lwq'
                  ? createSatisfactoryQuery(portFor(game, 'game'))
                  : createNullQuery(game))
            // Every protocol-based admin channel reads its credentials
            // from the config file the settings invariants maintain, so a
            // password rotation reaches the client without a restart.
            const adminCreds = (): { port: number | null; password: string | null } =>
              readAdminCreds(game.slug, row.installDir)
            const admin =
              game.capabilities.players === 'pal-rest' && palRest
                ? palRest
                : game.capabilities.players === 'rcon'
                  ? createRconAdmin(game.slug, adminCreds)
                  : game.capabilities.players === 'webrcon'
                    ? createRustWebrcon(adminCreds)
                    : game.capabilities.players === 'telnet'
                      ? create7dtdTelnet(adminCreds)
                      : createNullAdmin(game)
            // Samples the unit's cgroup on its own timer from panel
            // start, so the history window is already filled by the time
            // someone opens the Monitoring page to ask what just happened.
            const metrics = createRealMetricsSampler(logger, {
              unitName: row.unitName,
              game,
              query,
              journal,
              getOverrides: getResourceOverrides,
            })
            metrics.start()
            return {
              gameControl: createRealGameControl(env, logger, {
                unitName: row.unitName,
                installDir: row.installDir,
                installedProbe: game.installedProbe,
              }),
              query,
              admin,
              journal,
              metrics,
              steamcmd: createRealSteamCmd(env, logger, {
                steamAppId: game.steamAppId,
                installDir: row.installDir,
                platform: game.platform,
              }),
              dispose: () => {
                metrics.stop()
                journal.stop()
              },
            }
          })()

    const backup = game.capabilities.world
      ? createBackupService({
          env,
          db,
          logger,
          gameControl: base.gameControl,
          admin: base.admin,
          steamcmd: base.steamcmd,
          settings,
          serverId: row.id,
          installDir: row.installDir,
          backupDir,
          contract: contractFor(game),
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
      admin: base.admin,
      journal: base.journal,
      metrics: base.metrics,
      steamcmd: base.steamcmd,
      settings,
      backup,
      mods,
      longOps,
      worldLock,
      getResourceOverrides,
      setResourceOverrides: (overrides) => {
        resourceOverrides = overrides
      },
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
    env.PANEL_MODE === 'mock' ? createFakePublicAccess(instances) : createRealPublicAccess({ db, logger, instances })
  const unitProvisioner =
    env.PANEL_MODE === 'mock'
      ? createFakeUnitProvisioner(logger)
      : createRealUnitProvisioner(env, logger)
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
      admin: instance.admin,
      journal: instance.journal,
      metrics: instance.metrics,
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
