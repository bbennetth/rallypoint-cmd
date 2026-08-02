import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { Db } from '../db/client.js'
import type { Services } from './types.js'
import { LongOpRunner } from './long-op.js'
import { WorldLock } from './world-lock.js'
import { createFakeServices } from './fake/index.js'
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

// Composition root: picks real vs fake game integrations by PANEL_MODE.
// LongOpRunner and WorldLock are always real — they're pure in-process
// coordination.

export interface ComposedServices extends Services {
  dispose(): void
}

export function composeServices(env: Env, logger: Logger, db: Db): ComposedServices {
  const longOps = new LongOpRunner()
  const worldLock = new WorldLock()
  // The settings service is always the real implementation — in mock
  // mode it just operates on the sandbox ini files.
  const settings = createSettingsService(env, db)
  // Same for mods: pure fs work under PAL_DIR, which mock mode sandboxes.
  const mods = createModsService(env, logger)

  if (env.PANEL_MODE === 'mock') {
    const fakes = createFakeServices(env, logger)
    const backup = createBackupService({
      env,
      db,
      logger,
      gameControl: fakes.gameControl,
      palRest: fakes.palRest,
      steamcmd: fakes.steamcmd,
      settings,
    })
    backup.pruneStaging()
    const scheduler = createScheduler({
      env,
      db,
      logger,
      gameControl: fakes.gameControl,
      palRest: fakes.palRest,
      backup,
      worldLock,
    })
    return {
      ...fakes,
      longOps,
      worldLock,
      settings,
      backup,
      mods,
      scheduler,
      panelUpdate: createFakePanelUpdate(env),
      publicAccess: createFakePublicAccess(),
      dispose: () => {
        scheduler.stop()
        fakes.dispose()
      },
    }
  }

  const journal = createRealJournal(logger)
  journal.start()
  const gameControl = createRealGameControl(env, logger)
  const palRest = createRealPalRest(env, logger)
  const steamcmd = createRealSteamCmd(env, logger)
  const backup = createBackupService({ env, db, logger, gameControl, palRest, steamcmd, settings })
  backup.pruneStaging()
  const scheduler = createScheduler({ env, db, logger, gameControl, palRest, backup, worldLock })
  return {
    gameControl,
    palRest,
    journal,
    steamcmd,
    longOps,
    worldLock,
    settings,
    backup,
    mods,
    scheduler,
    panelUpdate: createRealPanelUpdate({ env, db, logger }),
    publicAccess: createRealPublicAccess({ env, db, logger }),
    dispose: () => {
      scheduler.stop()
      journal.stop()
    },
  }
}
