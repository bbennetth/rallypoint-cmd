import { eq } from 'drizzle-orm'
import type { GameDef } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import { panelState } from '../db/schema/index.js'
import type { GameQuery } from './types.js'
import { IniParseError, type SettingsService } from './settings-ini.js'
import { BackupError, type BackupService } from './backup.js'
import { ModError, type ModsService } from './mods.js'

// Null adapters for games that lack a capability. Routes are gated by
// the registry capabilities before these are ever reached, so the throws
// are a defensive backstop, not a UX surface.

export function createNullQuery(game: GameDef): GameQuery {
  const unavailable = (): never => {
    throw new Error(`${game.name} has no admin/query API.`)
  }
  return {
    reachable: () => Promise.resolve(false),
    info: unavailable,
    players: unavailable,
    metrics: unavailable,
    announce: unavailable,
    kick: unavailable,
    ban: unavailable,
    unban: unavailable,
    save: unavailable,
  }
}

// Settings for adapter kind 'none': no editable file, but the
// pending-restart flag still works (updates/power flows toggle it).
export function createNullSettings(db: Db, game: GameDef, stateKey: string): SettingsService {
  const unsupported = (): never => {
    throw new IniParseError(`${game.name} has no panel-editable settings file.`)
  }
  const setPending = (value: boolean): void => {
    db.insert(panelState)
      .values({ key: stateKey, value: value ? '1' : '0', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: panelState.key,
        set: { value: value ? '1' : '0', updatedAt: new Date() },
      })
      .run()
  }
  return {
    read: unsupported,
    writeStructured: unsupported,
    readRaw: unsupported,
    writeRaw: unsupported,
    seedIfMissing() {
      // Games without a panel-editable settings file need no seed.
    },
    getPendingRestart() {
      const row = db
        .select({ value: panelState.value })
        .from(panelState)
        .where(eq(panelState.key, stateKey))
        .get()
      return row?.value === '1'
    },
    markPendingRestart() {
      setPending(true)
    },

    clearPendingRestart() {
      setPending(false)
    },
  }
}

export function createNullBackup(game: GameDef): BackupService {
  const unsupported = (): never => {
    throw new BackupError(`Backups are not supported for ${game.name} yet.`, 'not_installed')
  }
  return {
    create: unsupported,
    list: () => [],
    filePathFor: unsupported,
    delete: unsupported,
    stageUpload: unsupported,
    restore: unsupported,
    pruneStaging: () => {},
  }
}

export function createNullMods(game: GameDef): ModsService {
  const unsupported = (): never => {
    throw new ModError(`Mods are not supported for ${game.name}.`, 'not_found')
  }
  return {
    list: () => [],
    installFromUpload: unsupported,
    setEnabled: unsupported,
    delete: unsupported,
  }
}
