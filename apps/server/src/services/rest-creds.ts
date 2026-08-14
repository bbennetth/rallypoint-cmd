import fs from 'node:fs'
import path from 'node:path'
import { PAL_SETTINGS_INI } from './constants.js'

// Reads the REST credentials the panel itself manages in
// PalWorldSettings.ini (AdminPassword + RESTAPIPort). Deliberately a
// tolerant, read-only extraction — the full round-trip parser lives in
// settings-ini.ts; this stays regex-simple so pal-rest can't be broken
// by an ini the parser would reject. Cached by mtime.

export interface RestCreds {
  password: string
  port: number
}

interface Cache {
  mtimeMs: number
  creds: RestCreds
}

// Keyed by install dir — multiple Palworld instances each get their own
// cached creds.
const cache = new Map<string, Cache>()

export function readRestCreds(palDir: string): RestCreds {
  const iniPath = path.join(palDir, PAL_SETTINGS_INI)
  const stat = fs.statSync(iniPath)
  const hit = cache.get(palDir)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.creds

  const content = fs.readFileSync(iniPath, 'utf8')
  const pwMatch = content.match(/AdminPassword\s*=\s*"((?:[^"\\]|\\.)*)"/)
  const portMatch = content.match(/RESTAPIPort\s*=\s*(\d+)/)
  const creds: RestCreds = {
    password: pwMatch?.[1] ?? '',
    port: portMatch ? Number(portMatch[1]) : 8212,
  }
  cache.set(palDir, { mtimeMs: stat.mtimeMs, creds })
  return creds
}

export function invalidateRestCredsCache(): void {
  cache.clear()
}
