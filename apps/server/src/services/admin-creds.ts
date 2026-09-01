import fs from 'node:fs'
import path from 'node:path'
import { gameBySlug } from '@rallypoint-cmd/shared'

// Reads the admin-channel credentials the panel itself manages in each
// game's config file (the RCON/telnet port and password that the
// settings invariants write). Same shape as rest-creds.ts and for the
// same reason: a tolerant regex extraction that can't be broken by a
// config the round-trip parser would reject, cached by mtime.

export interface AdminCreds {
  port: number | null
  password: string | null
}

interface Extractor {
  // Config file holding the credentials, relative to the install dir.
  file: string
  read(content: string, slug: string): AdminCreds
}

function portFromRegistry(slug: string, name: 'rcon' | 'telnet'): number | null {
  return gameBySlug(slug)?.ports.find((p) => p.name === name)?.port ?? null
}

// `<property name="TelnetPort" value="8081"/>`
function xmlProperty(content: string, key: string): string | null {
  const re = new RegExp(`<property\\s+name\\s*=\\s*"${key}"\\s+value\\s*=\\s*"([^"]*)"`, 'i')
  return content.match(re)?.[1] ?? null
}

// `Key=Value` on its own line (ini and ARK's sectioned ini alike — the
// panel-managed keys are unique across sections in both).
function iniValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'im')
  return content.match(re)?.[1] ?? null
}

// `cvar value` / `+cvar value`, quoted or bare, as written in a Source
// server.cfg or a launch conf.
function cfgValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*\\+?${key.replace(/\./g, '\\.')}\\s+"?([^"\\s]*)"?\\s*$`, 'im')
  return content.match(re)?.[1] ?? null
}

const EXTRACTORS: Record<string, Extractor> = {
  'ark-survival-evolved': {
    file: 'ShooterGame/Saved/Config/LinuxServer/GameUserSettings.ini',
    read: (content, slug) => ({
      port: Number(iniValue(content, 'RCONPort')) || portFromRegistry(slug, 'rcon'),
      password: iniValue(content, 'ServerAdminPassword'),
    }),
  },
  '7-days-to-die': {
    file: 'serverconfig.xml',
    read: (content, slug) => ({
      port: Number(xmlProperty(content, 'TelnetPort')) || portFromRegistry(slug, 'telnet'),
      password: xmlProperty(content, 'TelnetPassword'),
    }),
  },
  'project-zomboid': {
    file: 'Zomboid/Server/rallypoint.ini',
    read: (content, slug) => ({
      port: Number(iniValue(content, 'RCONPort')) || portFromRegistry(slug, 'rcon'),
      password: iniValue(content, 'RCONPassword'),
    }),
  },
  'team-fortress-2': {
    file: 'tf/cfg/server.cfg',
    read: (content, slug) => ({
      port: portFromRegistry(slug, 'rcon'),
      password: cfgValue(content, 'rcon_password'),
    }),
  },
  'counter-strike-2': {
    file: 'game/csgo/cfg/server.cfg',
    read: (content, slug) => ({
      port: portFromRegistry(slug, 'rcon'),
      password: cfgValue(content, 'rcon_password'),
    }),
  },
  // Rust's RCON convars are only honored from the command line, so they
  // live in the panel-owned launch conf rather than server.cfg.
  rust: {
    file: 'rallypoint-launch.conf',
    read: (content, slug) => ({
      port: Number(cfgValue(content, 'rcon.port')) || portFromRegistry(slug, 'rcon'),
      password: cfgValue(content, 'rcon.password'),
    }),
  },
}

interface Cache {
  mtimeMs: number
  creds: AdminCreds
}

// Keyed by install dir — each managed instance caches its own creds.
const cache = new Map<string, Cache>()

// Never throws: a missing or unreadable config means "not configured
// yet", which the admin clients report as an unreachable channel rather
// than a crash (the game may simply not have booted once yet).
export function readAdminCreds(slug: string, installDir: string): AdminCreds {
  const extractor = EXTRACTORS[slug]
  if (!extractor) return { port: null, password: null }
  const file = path.join(installDir, extractor.file)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { port: portFromRegistry(slug, 'rcon') ?? portFromRegistry(slug, 'telnet'), password: null }
  }
  const hit = cache.get(installDir)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.creds

  let creds: AdminCreds
  try {
    creds = extractor.read(fs.readFileSync(file, 'utf8'), slug)
  } catch {
    creds = { port: null, password: null }
  }
  if (!creds.password) creds = { ...creds, password: null }
  cache.set(installDir, { mtimeMs: stat.mtimeMs, creds })
  return creds
}

// Called after a settings write or a restore swaps the config out from
// under us.
export function invalidateAdminCredsCache(installDir?: string): void {
  if (installDir) cache.delete(installDir)
  else cache.clear()
}
