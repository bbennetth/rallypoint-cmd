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

// ---------------------------------------------------------------------
// World-id-free, whole-save-dir contracts.
//
// Every remaining game follows the Enshrouded shape: one save root under
// the install dir, archived wholesale, swapped back wholesale, `worldId:
// null` throughout. The generated start.sh sets HOME=installDir, so the
// dot-dirs below (.config, .local) really do land inside the install dir.
// The only per-game variation is the save root, which top-level dirs are
// excluded, which config files ride along, and what "this archive holds a
// real save" looks like — so they share one factory.

// Recursively collect file basenames under `dir` (empty on a missing
// dir). Save trees here are small; a full walk is cheap and lets the
// per-game probes below just ask "is there a *.sav anywhere in here?".
function listFilesDeep(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...listFilesDeep(path.join(dir, entry.name)))
    else if (entry.isFile()) out.push(entry.name)
  }
  return out
}

function hasExt(dir: string, ...exts: string[]): boolean {
  return listFilesDeep(dir).some((name) => exts.some((ext) => name.toLowerCase().endsWith(ext)))
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

interface SaveDirContractSpec {
  gameSlug: string
  // Save root relative to the install dir; also the archive's save root.
  saveRoot: string
  // Top-level dirs inside the save root kept out of our archives.
  internalBackupDirs?: readonly string[]
  // Config files (relative to the install dir) carried at archive root.
  configFiles?: readonly string[]
  settingsImportFile?: string | null
  // "Does this dir look like a real save?" — used both to gate create()
  // (on the live dir) and to sanity-check an uploaded archive.
  looksLikeSave(saveDir: string): boolean
  // Operator-facing reason when looksLikeSave() rejects an archive.
  invalidReason: string
}

function saveDirContract(spec: SaveDirContractSpec): WorldContract {
  const saveRoot = spec.saveRoot
  const configFiles = spec.configFiles ?? []
  const settingsBasenames = new Set(configFiles.map((f) => path.basename(f)))
  return {
    gameSlug: spec.gameSlug,
    filenamePrefix: spec.gameSlug,
    internalBackupDirs: spec.internalBackupDirs ?? [],
    configFiles,
    settingsImportFile: spec.settingsImportFile ?? null,

    resolveLive(installDir) {
      const saveDir = path.join(installDir, saveRoot)
      if (!isNonEmptyDir(saveDir)) return null
      return { worldId: null, saveDir }
    },

    archiveSaveRoot() {
      return saveRoot
    },

    classifyEntry(entryPath) {
      const clean = entryPath.replace(/\\/g, '/').replace(/\/$/, '')
      if (clean === 'manifest.json') return { kind: 'manifest' }
      if (settingsBasenames.has(clean)) return { kind: 'settings' }
      // The save root's own ancestor dirs are legitimate archive entries
      // (tar emits `.config`, `.config/unity3d`, ... before the leaf).
      const segments = saveRoot.split('/')
      for (let i = 1; i <= segments.length; i++) {
        if (clean === segments.slice(0, i).join('/')) return { kind: 'dir' }
      }
      if (clean.startsWith(`${saveRoot}/`)) return { kind: 'save', worldId: null }
      return { kind: 'unknown' }
    },

    validateSaveShape(_saveWorldIds, saveFileCount) {
      if (saveFileCount < 1) {
        throw new BackupError('Archive has no savegame files.', 'archive_invalid')
      }
      return null
    },

    verifyExtracted(extractDir) {
      if (!spec.looksLikeSave(path.join(extractDir, saveRoot))) {
        throw new BackupError(spec.invalidReason, 'archive_invalid')
      }
    },

    stagedSaveTarget(extractDir) {
      return { stagedDir: path.join(extractDir, saveRoot), worldId: null }
    },

    liveSaveDirIn(installDir) {
      return path.join(installDir, saveRoot)
    },

    confirmToken() {
      return null
    },

    postSwapFixup() {
      // No named-world pointer to fix up: the whole save root is swapped.
    },

    verifySwap(installDir) {
      if (!isNonEmptyDir(path.join(installDir, saveRoot))) {
        throw new BackupError('Save swap did not take: the save dir is missing or empty.', 'restore_failed')
      }
    },
  }
}

// Valheim keeps `<world>.db` (world state) + `<world>.fwl` (metadata)
// pairs in worlds_local. The launch args name the world (`-world
// Dedicated`); a restored save whose world name differs from the
// configured one boots a fresh world instead. Rewriting the launch conf
// is a later change — for now the restored world must match the name the
// unit was generated with.
export const valheimContract = saveDirContract({
  gameSlug: 'valheim',
  saveRoot: '.config/unity3d/IronGate/Valheim/worlds_local',
  looksLikeSave: (dir) => hasExt(dir, '.db', '.fwl'),
  invalidReason: 'Archive has no .db/.fwl world files — not a Valheim world.',
})

// Rust's server identity dir holds the map/save (`*.sav`) AND `cfg/`
// (server.cfg, users.cfg — owner/moderator lists). Both are world state
// as far as an operator is concerned, so cfg/ is archived deliberately.
export const rustContract = saveDirContract({
  gameSlug: 'rust',
  saveRoot: 'server/rallypoint',
  looksLikeSave: (dir) => hasExt(dir, '.sav'),
  invalidReason: 'Archive has no .sav files — not a Rust save.',
})

// ARK stores world/player/tribe data as *.ark under SavedArks, while the
// panel-managed knobs live in GameUserSettings.ini one dir over — carried
// at archive root so a restore re-applies them alongside the world.
export const arkContract = saveDirContract({
  gameSlug: 'ark-survival-evolved',
  saveRoot: 'ShooterGame/Saved/SavedArks',
  configFiles: ['ShooterGame/Saved/Config/LinuxServer/GameUserSettings.ini'],
  // Re-imported through the settings adapter on restore so panel
  // invariants are re-enforced; until ARK has an adapter the engine
  // degrades to a "kept current settings" log line.
  settingsImportFile: 'GameUserSettings.ini',
  looksLikeSave: (dir) => hasExt(dir, '.ark'),
  invalidReason: 'Archive has no .ark files — not an ARK save.',
})

// 7 Days to Die: Saves/<world>/<gamename>/ holds the player + region
// data. The sibling GeneratedWorlds dir (RWG output) is NOT archived in
// v1 — it is many hundreds of MiB and regenerates deterministically from
// the world seed, so restoring saves without it is safe.
export const sevenDaysContract = saveDirContract({
  gameSlug: '7-days-to-die',
  saveRoot: '.local/share/7DaysToDie/Saves',
  looksLikeSave: isNonEmptyDir,
  invalidReason: 'Archive has an empty Saves dir — nothing to restore.',
})

// Project Zomboid writes everything under ~/Zomboid: Saves/ is world
// state, Logs/ is noise, and Server/ holds the ini the panel manages —
// that rides along as a config file instead (so a restore re-applies it
// through the settings adapter rather than clobbering the dir wholesale).
export const zomboidContract = saveDirContract({
  gameSlug: 'project-zomboid',
  saveRoot: 'Zomboid',
  internalBackupDirs: ['Logs', 'Server'],
  configFiles: ['Zomboid/Server/rallypoint.ini'],
  settingsImportFile: 'rallypoint.ini',
  looksLikeSave: (dir) => isNonEmptyDir(path.join(dir, 'Saves')),
  invalidReason: 'Archive has no non-empty Saves dir — not a Project Zomboid save.',
})

// Satisfactory autosaves are *.sav blobs in the Epic save dir.
export const satisfactoryContract = saveDirContract({
  gameSlug: 'satisfactory',
  saveRoot: '.config/Epic/FactoryGame/Saved/SaveGames',
  looksLikeSave: (dir) => hasExt(dir, '.sav'),
  invalidReason: 'Archive has no .sav files — not a Satisfactory save.',
})

// Unturned keeps per-server state (Level/, Players/, Config.json) under
// Servers/<instance>/ — no single marker file to key on, so "non-empty"
// is the strongest honest check.
export const unturnedContract = saveDirContract({
  gameSlug: 'unturned',
  saveRoot: 'Servers',
  looksLikeSave: isNonEmptyDir,
  invalidReason: 'Archive has an empty Servers dir — nothing to restore.',
})

const CONTRACTS: Record<string, WorldContract> = {
  palworld: palworldContract,
  enshrouded: enshroudedContract,
  valheim: valheimContract,
  rust: rustContract,
  'ark-survival-evolved': arkContract,
  '7-days-to-die': sevenDaysContract,
  'project-zomboid': zomboidContract,
  satisfactory: satisfactoryContract,
  unturned: unturnedContract,
}

// Slug → contract, for tests and callers that hold a slug rather than a
// GameDef. Contracts exist ahead of the registry's `capabilities.world`
// flags flipping on, so this resolves for every game listed above.
export function contractForSlug(slug: string): WorldContract | undefined {
  return CONTRACTS[slug]
}

export function contractFor(game: GameDef): WorldContract {
  const contract = CONTRACTS[game.slug]
  if (!contract) throw new Error(`${game.name} has world backups enabled but no world contract`)
  return contract
}
