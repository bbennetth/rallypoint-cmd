import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { SettingsEntry, SettingValue } from '@rallypoint-cmd/shared'
import { MANAGED_KEYS, PAL_KEY_SPECS } from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import { panelState } from '../db/schema/index.js'
import { PAL_SETTINGS_INI } from './constants.js'
import { invalidateRestCredsCache } from './rest-creds.js'

// PalWorldSettings.ini round-trip engine. The file is one
// `[/Script/Pal.PalGameWorldSettings]` section whose OptionSettings=(…)
// tuple holds every key. We tokenize the tuple preserving each key's RAW
// value text, re-render only keys that changed, and never drop unknown
// keys — Palworld adds OptionSettings across patches and clobbering them
// silently resets hidden settings.

export interface ParsedIni {
  // Text before the tuple's opening paren (includes "OptionSettings=(").
  prefix: string
  // Ordered key → raw value text, exactly as found.
  entries: Map<string, string>
  // Text from the closing paren to EOF (includes ")").
  suffix: string
}

export class IniParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IniParseError'
  }
}

export function parseIni(content: string): ParsedIni {
  const marker = 'OptionSettings=('
  const start = content.indexOf(marker)
  if (start < 0) throw new IniParseError('OptionSettings=( not found')
  const innerStart = start + marker.length

  // Find the matching ")" balancing parens, respecting double-quotes.
  let depth = 1
  let inQuotes = false
  let end = -1
  for (let i = innerStart; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') inQuotes = false
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new IniParseError('unbalanced parentheses in OptionSettings tuple')

  const inner = content.slice(innerStart, end)
  const entries = new Map<string, string>()
  for (const token of splitTopLevel(inner)) {
    if (token.trim() === '') continue
    const eqIdx = topLevelEqualsIndex(token)
    if (eqIdx < 0) throw new IniParseError(`tuple entry has no '=': ${token.slice(0, 50)}`)
    const key = token.slice(0, eqIdx).trim()
    const raw = token.slice(eqIdx + 1)
    if (!key) throw new IniParseError('empty key in OptionSettings tuple')
    entries.set(key, raw)
  }

  return {
    prefix: content.slice(0, innerStart),
    entries,
    suffix: content.slice(end),
  }
}

// Split the tuple inner text on top-level commas (quote- and
// paren-aware — ServerName="A, B (test)" stays one token).
function splitTopLevel(inner: string): string[] {
  const tokens: string[] = []
  let current = ''
  let depth = 0
  let inQuotes = false
  for (const ch of inner) {
    if (inQuotes) {
      current += ch
      if (ch === '"') inQuotes = false
      continue
    }
    if (ch === '"') {
      inQuotes = true
      current += ch
    } else if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      tokens.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function topLevelEqualsIndex(token: string): number {
  let inQuotes = false
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (inQuotes) {
      if (ch === '"') inQuotes = false
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === '=') return i
  }
  return -1
}

export function serializeIni(parsed: ParsedIni): string {
  const inner = [...parsed.entries.entries()].map(([k, v]) => `${k}=${v}`).join(',')
  return parsed.prefix + inner + parsed.suffix
}

// --- value coercion ---------------------------------------------------------

export function coerceValue(kind: string, raw: string): SettingValue | null {
  const trimmed = raw.trim()
  switch (kind) {
    case 'bool':
      if (/^true$/i.test(trimmed)) return true
      if (/^false$/i.test(trimmed)) return false
      return null
    case 'int': {
      const n = Number(trimmed)
      return Number.isInteger(n) ? n : null
    }
    case 'float': {
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : null
    }
    case 'string':
      if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1)
      }
      return trimmed
    case 'enum':
      return trimmed
    default:
      return null
  }
}

export function renderValue(kind: string, value: SettingValue, previousRaw?: string): string {
  switch (kind) {
    case 'bool':
      return value === true || value === 'true' || value === 'True' ? 'True' : 'False'
    case 'int':
      return String(Math.trunc(Number(value)))
    case 'float': {
      // Keep UE's 6-decimal style when the file used it.
      const n = Number(value)
      const usedFixed = previousRaw ? /^\s*-?\d+\.\d{6}\s*$/.test(previousRaw) : true
      return usedFixed ? n.toFixed(6) : String(n)
    }
    case 'string': {
      const s = String(value)
      if (s.includes('"')) throw new IniParseError('string settings must not contain double quotes')
      return `"${s}"`
    }
    case 'enum':
      return String(value)
    default:
      return String(value)
  }
}

// --- panel invariants -------------------------------------------------------

// Enforced LAST on every write so a user edit can never lock the panel
// out of the game's REST API. Returns the generated AdminPassword if one
// had to be created.
export function applyInvariants(parsed: ParsedIni, restPort: number): void {
  parsed.entries.set('RESTAPIEnabled', 'True')
  parsed.entries.set('RESTAPIPort', String(restPort))
  parsed.entries.set('RCONEnabled', 'False')
  const admin = parsed.entries.get('AdminPassword')
  const adminValue = admin ? coerceValue('string', admin) : ''
  if (!adminValue || adminValue === '') {
    parsed.entries.set('AdminPassword', `"${randomBytes(18).toString('base64url')}"`)
  }
}

// --- service ----------------------------------------------------------------

export interface SettingsService {
  read(): { entries: SettingsEntry[] }
  writeStructured(values: Record<string, SettingValue>): void
  readRaw(): string
  writeRaw(content: string): void
  getPendingRestart(): boolean
  clearPendingRestart(): void
}

export interface SettingsTarget {
  installDir: string
  // panel_state key tracking this instance's pending-restart flag. The
  // seeded default server keeps the historical bare 'pendingRestart' key.
  stateKey: string
}

export function createSettingsService(env: Env, db: Db, target: SettingsTarget): SettingsService {
  const iniPath = path.join(target.installDir, PAL_SETTINGS_INI)
  const restPort = Number(new URL(env.PAL_REST_URL).port || '8212')

  function readContent(): string {
    if (!fs.existsSync(iniPath)) {
      throw new IniParseError('PalWorldSettings.ini not found — is the server installed?')
    }
    return fs.readFileSync(iniPath, 'utf8')
  }

  function writeContent(content: string): void {
    // Keep an undo copy, then temp-file + rename (atomic on same fs).
    const historyDir = path.join(env.DATA_DIR, 'ini-history', target.stateKey.replace(/[^a-zA-Z0-9_-]/g, '_'))
    fs.mkdirSync(historyDir, { recursive: true })
    if (fs.existsSync(iniPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(iniPath, path.join(historyDir, `PalWorldSettings-${stamp}.ini`))
      pruneHistory(historyDir, 20)
    }
    const tmp = `${iniPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, { mode: 0o640 })
    fs.renameSync(tmp, iniPath)
    invalidateRestCredsCache()
    setPending(true)
  }

  function setPending(value: boolean): void {
    db.insert(panelState)
      .values({ key: target.stateKey, value: value ? '1' : '0', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: panelState.key,
        set: { value: value ? '1' : '0', updatedAt: new Date() },
      })
      .run()
  }

  return {
    read() {
      const parsed = parseIni(readContent())
      const entries: SettingsEntry[] = [...parsed.entries.entries()].map(([key, raw]) => {
        const spec = PAL_KEY_SPECS[key]
        return {
          key,
          raw,
          value: spec ? coerceValue(spec.kind, raw) : null,
          kind: spec?.kind ?? null,
          enumValues: spec?.enumValues ? [...spec.enumValues] : null,
          managed: spec?.managed ?? false,
          label: spec?.label ?? null,
        }
      })
      return { entries }
    },

    writeStructured(values) {
      const parsed = parseIni(readContent())
      for (const [key, value] of Object.entries(values)) {
        if ((MANAGED_KEYS as readonly string[]).includes(key)) {
          throw new IniParseError(`${key} is panel-managed and cannot be edited`)
        }
        const spec = PAL_KEY_SPECS[key]
        if (spec) {
          if (spec.kind === 'enum' && spec.enumValues && !spec.enumValues.includes(String(value))) {
            throw new IniParseError(`${key} must be one of: ${spec.enumValues.join(', ')}`)
          }
          parsed.entries.set(key, renderValue(spec.kind, value, parsed.entries.get(key)))
        } else if (parsed.entries.has(key)) {
          // Unknown-but-present key: accept a verbatim raw string only.
          if (typeof value !== 'string') {
            throw new IniParseError(`${key} is not a known setting; provide its raw string value`)
          }
          parsed.entries.set(key, value)
        } else {
          throw new IniParseError(`${key} is not a known setting and not present in the file`)
        }
      }
      applyInvariants(parsed, restPort)
      writeContent(serializeIni(parsed))
    },

    readRaw() {
      return readContent()
    },

    writeRaw(content) {
      const parsed = parseIni(content) // throws IniParseError on garbage
      applyInvariants(parsed, restPort)
      writeContent(serializeIni(parsed))
    },

    getPendingRestart() {
      const row = db
        .select({ value: panelState.value })
        .from(panelState)
        .where(eq(panelState.key, target.stateKey))
        .get()
      return row?.value === '1'
    },

    clearPendingRestart() {
      setPending(false)
    },
  }
}

function pruneHistory(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ini'))
    .sort()
  while (files.length > keep) {
    const oldest = files.shift()
    if (oldest) fs.unlinkSync(path.join(dir, oldest))
  }
}
