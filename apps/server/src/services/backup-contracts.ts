import fs from 'node:fs'
import path from 'node:path'
import type { BackupManifest, GameDef } from '@rallypoint-cmd/shared'
import { BackupError, PAL_INTERNAL_BACKUP_DIRS } from './backup.js'
import {
  ENSHROUDED_SAVE_DIR,
  ENSHROUDED_SERVER_JSON,
  PAL_GAME_USER_SETTINGS_INI,
  PAL_SETTINGS_INI,
} from './constants.js'
import { resolveWorldId, saveDirFor } from './world.js'

// Per-game archive/world contract for the backup engine. The engine
// (backup.ts) owns every hard-won guardrail — churn-tolerant copies,
// zip-slip/bomb checks, the stop→swap→restart→verify→rollback
// choreography — and this object supplies only the game-shaped parts:
// where saves live, what an archive may contain, and any post-swap
// fixups. Palworld keeps its named-world (32-hex id) semantics;
// world-id-free games (Enshrouded) use `worldId: null` throughout.

export interface EntryClass {
  kind: 'manifest' | 'settings' | 'dir' | 'save' | 'unknown'
  // For 'save' entries: the world id the entry belongs to (null for
  // games without named worlds).
  worldId?: string | null
}

export interface WorldContract {
  gameSlug: string
  // Archive filename prefix (`<prefix>[-<worldId8>]-<stamp>.tar.gz`).
  filenamePrefix: string
  // Top-level dirs inside the save dir that are the game's own internal
  // backups, excluded from our archives (and the main copy-churn source).
  internalBackupDirs: readonly string[]
  // Config files (relative to the install dir) copied to the archive
  // root by basename.
  configFiles: readonly string[]
  // Archive-root settings file re-imported via settings.writeRaw on
  // restore (null = none).
  settingsImportFile: string | null
  // Live save resolution for create(); null → 'no_world' error.
  resolveLive(installDir: string): { worldId: string | null; saveDir: string } | null
  // Where the save tree lives inside the archive (create staging).
  archiveSaveRoot(worldId: string | null): string
  // Which part of the archive contract an entry satisfies.
  classifyEntry(entryPath: string): EntryClass
  // Shape rule over the discovered save entries; returns the archive's
  // world id (null for world-id-free games). Throws BackupError.
  validateSaveShape(saveWorldIds: Set<string>, saveFileCount: number): string | null
  // Post-extract sanity probe on the staged archive. Throws BackupError.
  verifyExtracted(extractDir: string): void
  // The staged save dir inside an extracted archive + its world id.
  stagedSaveTarget(extractDir: string): { stagedDir: string; worldId: string | null }
  // Where the live save dir for a (possibly null) world id lives.
  liveSaveDirIn(installDir: string, worldId: string | null): string
  // Confirm token the user may type instead of the literal 'restore'
  // (null → only 'restore' is accepted).
  confirmToken(manifest: BackupManifest): string | null
  // Post-swap fixups (Palworld: DedicatedServerName rewrite + stray
  // case-sibling warning; world-id-free games: no-op).
  postSwapFixup(args: { installDir: string; targetWorldId: string | null; say: (line: string) => void }): void
  // Post-swap verification that the restored save is the active one.
  // Throws BackupError on failure (triggers rollback).
  verifySwap(installDir: string, targetWorldId: string | null): void
}

const HEX32 = /^[0-9A-Fa-f]{32}$/

export const palworldContract: WorldContract = {
  gameSlug: 'palworld',
  filenamePrefix: 'palworld',
  internalBackupDirs: PAL_INTERNAL_BACKUP_DIRS,
  configFiles: [PAL_SETTINGS_INI, PAL_GAME_USER_SETTINGS_INI],
  settingsImportFile: 'PalWorldSettings.ini',

  resolveLive(installDir) {
    const worldId = resolveWorldId(installDir)
    if (!worldId) return null
    return { worldId, saveDir: saveDirFor(installDir, worldId) }
  },

  archiveSaveRoot(worldId) {
    return path.join('SaveGames', '0', worldId!)
  },

  classifyEntry(entryPath) {
    const clean = entryPath.replace(/\\/g, '/').replace(/\/$/, '')
    if (clean === 'manifest.json') return { kind: 'manifest' }
    if (clean === 'PalWorldSettings.ini' || clean === 'GameUserSettings.ini') return { kind: 'settings' }
    if (clean === 'SaveGames' || clean === 'SaveGames/0') return { kind: 'dir' }
    const m = clean.match(/^SaveGames\/0\/([^/]+)(\/|$)/)
    if (m) return { kind: 'save', worldId: m[1]! }
    return { kind: 'unknown' }
  },

  validateSaveShape(saveWorldIds) {
    for (const id of saveWorldIds) {
      if (!HEX32.test(id)) {
        throw new BackupError(`Unexpected world dir in archive: ${id}`, 'archive_invalid')
      }
    }
    if (saveWorldIds.size !== 1) {
      throw new BackupError('Archive must contain exactly one world save.', 'archive_invalid')
    }
    return [...saveWorldIds][0]!
  },

  verifyExtracted(extractDir) {
    const dirs = fs.readdirSync(path.join(extractDir, 'SaveGames', '0'))
    const worldId = dirs[0]
    if (!worldId || !fs.existsSync(path.join(extractDir, 'SaveGames', '0', worldId, 'Level.sav'))) {
      throw new BackupError('Archive save dir has no Level.sav — not a Palworld world.', 'archive_invalid')
    }
  },

  stagedSaveTarget(extractDir) {
    const dirs = fs.readdirSync(path.join(extractDir, 'SaveGames', '0'))
    const stagedDir = path.join(extractDir, 'SaveGames', '0', dirs[0]!)
    return { stagedDir, worldId: path.basename(stagedDir) }
  },

  liveSaveDirIn(installDir, worldId) {
    return saveDirFor(installDir, worldId!)
  },

  confirmToken(manifest) {
    return manifest.worldId
  },

  postSwapFixup({ installDir, targetWorldId, say }) {
    // Point DedicatedServerName at the restored world if it moved.
    // CASE MATTERS: the game joins this string onto the save path
    // directly, and Linux filesystems are case-sensitive — a lowercased
    // id pointing at an UPPERCASE dir makes Palworld silently create a
    // FRESH world under the lowercase name while the panel keeps showing
    // and backing up the restored dir. Write the dir's exact name.
    const gusPath = path.join(installDir, PAL_GAME_USER_SETTINGS_INI)
    if (fs.existsSync(gusPath)) {
      const gus = fs.readFileSync(gusPath, 'utf8')
      const updated = gus.replace(
        /DedicatedServerName\s*=\s*[0-9A-Fa-f]{32}/,
        `DedicatedServerName=${targetWorldId}`,
      )
      if (updated !== gus) {
        say('[restore] Updating DedicatedServerName to match restored world.')
        fs.writeFileSync(gusPath, updated)
      }
    }
    // A sibling dir differing only by case (e.g. a fresh world the game
    // created off a wrongly-cased DedicatedServerName) is a trap — call
    // it out so a puzzled operator can see it.
    const saveRoot = path.dirname(saveDirFor(installDir, targetWorldId!))
    for (const sibling of fs.readdirSync(saveRoot)) {
      if (sibling !== targetWorldId && sibling.toLowerCase() === targetWorldId!.toLowerCase()) {
        say(
          `[restore] WARNING: a case-mismatched sibling save dir exists (${sibling}) — the server now uses ${targetWorldId}; the sibling is likely a stray auto-created world and can be deleted.`,
        )
      }
    }
  },

  verifySwap(installDir, targetWorldId) {
    // The panel must now resolve the restored world as the active one,
    // or the game would boot something else entirely.
    const resolved = resolveWorldId(installDir)
    if (resolved?.toLowerCase() !== targetWorldId!.toLowerCase()) {
      throw new BackupError(
        `World swap did not take: the active world resolves to ${resolved ?? 'none'} instead of ${targetWorldId}.`,
        'restore_failed',
      )
    }
  },
}

export const enshroudedContract: WorldContract = {
  gameSlug: 'enshrouded',
  filenamePrefix: 'enshrouded',
  internalBackupDirs: [],
  configFiles: [ENSHROUDED_SERVER_JSON],
  settingsImportFile: ENSHROUDED_SERVER_JSON,

  resolveLive(installDir) {
    const saveDir = path.join(installDir, ENSHROUDED_SAVE_DIR)
    try {
      if (fs.readdirSync(saveDir).length === 0) return null
    } catch {
      return null
    }
    return { worldId: null, saveDir }
  },

  archiveSaveRoot() {
    return ENSHROUDED_SAVE_DIR
  },

  classifyEntry(entryPath) {
    const clean = entryPath.replace(/\\/g, '/').replace(/\/$/, '')
    if (clean === 'manifest.json') return { kind: 'manifest' }
    if (clean === ENSHROUDED_SERVER_JSON) return { kind: 'settings' }
    if (clean === ENSHROUDED_SAVE_DIR) return { kind: 'dir' }
    if (clean.startsWith(`${ENSHROUDED_SAVE_DIR}/`)) return { kind: 'save', worldId: null }
    return { kind: 'unknown' }
  },

  validateSaveShape(_saveWorldIds, saveFileCount) {
    if (saveFileCount < 1) {
      throw new BackupError('Archive has no savegame files.', 'archive_invalid')
    }
    return null
  },

  verifyExtracted(extractDir) {
    const saveDir = path.join(extractDir, ENSHROUDED_SAVE_DIR)
    let entries: string[]
    try {
      entries = fs.readdirSync(saveDir)
    } catch {
      entries = []
    }
    if (entries.length === 0) {
      throw new BackupError('Archive has an empty savegame dir — nothing to restore.', 'archive_invalid')
    }
  },

  stagedSaveTarget(extractDir) {
    return { stagedDir: path.join(extractDir, ENSHROUDED_SAVE_DIR), worldId: null }
  },

  liveSaveDirIn(installDir) {
    return path.join(installDir, ENSHROUDED_SAVE_DIR)
  },

  confirmToken() {
    return null
  },

  postSwapFixup() {
    // No named-world pointer to fix up.
  },

  verifySwap(installDir) {
    const saveDir = path.join(installDir, ENSHROUDED_SAVE_DIR)
    let entries: string[]
    try {
      entries = fs.readdirSync(saveDir)
    } catch {
      entries = []
    }
    if (entries.length === 0) {
      throw new BackupError('Save swap did not take: the savegame dir is missing or empty.', 'restore_failed')
    }
  },
}

const CONTRACTS: Record<string, WorldContract> = {
  palworld: palworldContract,
  enshrouded: enshroudedContract,
}

export function contractFor(game: GameDef): WorldContract {
  const contract = CONTRACTS[game.slug]
  if (!contract) throw new Error(`${game.name} has world backups enabled but no world contract`)
  return contract
}
