import fs from 'node:fs'
import path from 'node:path'
import { PAL_GAME_USER_SETTINGS_INI, PAL_SAVE_ROOT } from './constants.js'

// Resolves the active world id (the 32-hex dir under
// Pal/Saved/SaveGames/0/). Source of truth is DedicatedServerName in
// GameUserSettings.ini; fall back to the only/most-recently-modified
// save dir. Never hardcode a world id anywhere else.

const HEX32 = /^[0-9A-Fa-f]{32}$/

export function resolveWorldId(palDir: string): string | null {
  const saveRoot = path.join(palDir, PAL_SAVE_ROOT)

  const fromIni = ((): string | null => {
    try {
      const gus = fs.readFileSync(path.join(palDir, PAL_GAME_USER_SETTINGS_INI), 'utf8')
      const m = gus.match(/DedicatedServerName\s*=\s*([0-9A-Fa-f]{32})/)
      return m?.[1] ?? null
    } catch {
      return null
    }
  })()
  if (fromIni) {
    const dir = findDirCaseInsensitive(saveRoot, fromIni)
    if (dir) return dir
  }

  // Fallback: enumerate save dirs.
  let entries: string[]
  try {
    entries = fs
      .readdirSync(saveRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && HEX32.test(e.name))
      .map((e) => e.name)
  } catch {
    return null
  }
  if (entries.length === 0) return null
  if (entries.length === 1) return entries[0]!
  // Most recently modified wins.
  return entries
    .map((name) => ({ name, mtime: fs.statSync(path.join(saveRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!.name
}

// The ini records the name lowercase while the dir is uppercase (or vice
// versa) on some installs — match case-insensitively against real dirs.
function findDirCaseInsensitive(saveRoot: string, worldId: string): string | null {
  try {
    const entries = fs.readdirSync(saveRoot, { withFileTypes: true })
    // Prefer the exact-case dir: when a stray sibling differs only by
    // case (a fresh world auto-created off a wrongly-cased ini), the
    // first readdir hit is arbitrary — the exact match is the real one.
    const exact = entries.find((e) => e.isDirectory() && e.name === worldId)
    if (exact) return exact.name
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === worldId.toLowerCase())
    return hit?.name ?? null
  } catch {
    return null
  }
}

export function saveDirFor(palDir: string, worldId: string): string {
  return path.join(palDir, PAL_SAVE_ROOT, worldId)
}

// Newest file mtime under a save dir — "when did the game last write a
// save". Skips the game's own internal-backup dirs at the top level and
// bounds the walk so a pathological tree can't stall the status route.
const MTIME_MAX_DEPTH = 4
const MTIME_MAX_ENTRIES = 2000

export function newestSaveMtimeMs(saveDir: string, excludeTopDirs: readonly string[] = []): number | null {
  let newest: number | null = null
  let budget = MTIME_MAX_ENTRIES
  const walk = (dir: string, depth: number, top: boolean): void => {
    if (depth > MTIME_MAX_DEPTH || budget <= 0) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (budget-- <= 0) return
      if (top && e.isDirectory() && excludeTopDirs.includes(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1, false)
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(p).mtimeMs
          if (newest === null || m > newest) newest = m
        } catch {
          // raced with a save-file swap — skip
        }
      }
    }
  }
  walk(saveDir, 0, true)
  return newest === null ? null : Math.floor(newest)
}
