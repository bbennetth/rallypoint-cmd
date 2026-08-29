import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { SettingsEntry, SettingValue } from '@rallypoint-cmd/shared'
import {
  ENSHROUDED_KEY_SPECS,
  ENSHROUDED_MANAGED_KEYS,
  ENSHROUDED_SETTINGS_CATEGORIES,
} from '@rallypoint-cmd/shared'
import type { Db } from '../db/client.js'
import type { Env } from '../env.js'
import { panelState } from '../db/schema/index.js'
import { ENSHROUDED_LOG_DIR, ENSHROUDED_SAVE_DIR, ENSHROUDED_SERVER_JSON } from './constants.js'
import { SettingsParseError, type SettingsService } from './settings-ini.js'

// enshrouded_server.json round-trip engine. The file is nested JSON the
// game itself generates on first boot: top-level scalars, a
// `gameSettings` object of tuning keys, and a `userGroups` array (roles
// + passwords). The panel edits scalars via flat dot-path keys and
// preserves everything else (userGroups, unknown keys) verbatim —
// Enshrouded adds keys across patches and dropping them silently resets
// hidden settings.

export class JsonParseError extends SettingsParseError {
  constructor(message: string) {
    super(message)
    this.name = 'JsonParseError'
  }
}

export interface JsonSettingsTarget {
  installDir: string
  // panel_state key tracking this instance's pending-restart flag,
  // namespaced by server id.
  stateKey: string
  // Ports the panel enforces in the file (from the game registry).
  gamePort: number
  queryPort: number
}

type JsonObject = Record<string, unknown>

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Get/set a `a.b` dot path (one level of nesting is all the file uses).
function getPath(obj: JsonObject, key: string): unknown {
  const parts = key.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(obj: JsonObject, key: string, value: unknown): void {
  const parts = key.split('.')
  let cur: JsonObject = obj
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (isPlainObject(next)) {
      cur = next
    } else {
      const created: JsonObject = {}
      cur[part] = created
      cur = created
    }
  }
  cur[parts.at(-1)!] = value
}

// Flatten the file's scalar values into dot-path keys: every scalar
// top-level key plus every scalar under one level of object nesting
// (gameSettings.*). Arrays and deeper objects are skipped — preserved
// verbatim, edited via the raw editor only.
export function flattenScalars(obj: JsonObject): { key: string; value: string | number | boolean }[] {
  const out: { key: string; value: string | number | boolean }[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (isScalar(value)) out.push({ key, value })
    else if (isPlainObject(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (isScalar(subValue)) out.push({ key: `${key}.${subKey}`, value: subValue })
      }
    }
  }
  return out
}

// Access control lives in the `userGroups` array (one password per
// role: Admin / Friend / Guest). Arrays are excluded from the flat
// editor, so group passwords are surfaced as virtual dot-path keys
// (`userGroups.Admin.password`) that read/write the matching array
// entry in place — everything else about the group is preserved.
const USER_GROUP_PASSWORD_RE = /^userGroups\.(.+)\.password$/

// The role trio current game builds generate on a fresh config. Files
// created before Content Update #2 carry a single "Default" group, so
// these are offered as empty password fields even when absent; setting
// one creates the group with the canonical permission grading (players
// pick their role by which password they type at join).
const CANONICAL_USER_GROUPS: readonly JsonObject[] = [
  { name: 'Admin', password: '', canKickBan: true, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
  { name: 'Friend', password: '', canKickBan: false, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
  { name: 'Guest', password: '', canKickBan: false, canAccessInventories: false, canEditWorld: false, canEditBase: false, canExtendBase: false, reservedSlots: 0 },
]

export function userGroupPasswordEntries(obj: JsonObject): { key: string; value: string; label: string }[] {
  const groups = obj['userGroups']
  if (!Array.isArray(groups)) return []
  const out: { key: string; value: string; label: string }[] = []
  for (const g of groups) {
    if (!isPlainObject(g) || typeof g['name'] !== 'string' || !g['name']) continue
    const pw = g['password']
    out.push({
      key: `userGroups.${g['name']}.password`,
      value: typeof pw === 'string' ? pw : '',
      label: `${g['name']} password`,
    })
  }
  // Offer the canonical roles even when the file predates them — setting
  // a password creates the group.
  for (const tmpl of CANONICAL_USER_GROUPS) {
    const name = tmpl['name'] as string
    if (!out.some((e) => e.key === `userGroups.${name}.password`)) {
      out.push({ key: `userGroups.${name}.password`, value: '', label: `${name} password (sets up the role)` })
    }
  }
  return out
}

function setUserGroupPassword(obj: JsonObject, groupName: string, value: string): void {
  if (!Array.isArray(obj['userGroups'])) obj['userGroups'] = []
  const groups = obj['userGroups'] as unknown[]
  const group = groups.find((g): g is JsonObject => isPlainObject(g) && g['name'] === groupName)
  if (group) {
    group['password'] = value
    return
  }
  const template = CANONICAL_USER_GROUPS.find((t) => t['name'] === groupName)
  if (!template) {
    throw new JsonParseError(
      `userGroups has no group named "${groupName}" — edit userGroups via the raw editor.`,
    )
  }
  // Leaving a canonical role's offered field empty is a no-op, not a
  // request to create a passwordless group.
  if (value === '') return
  groups.push({ ...template, password: value })
}

// Enshrouded validates userGroups at boot and exits with status 255
// when the rules are broken, which sends systemd into a restart loop.
// Mirror those rules on every panel write so a bad combination comes
// back as a 400 with an explanation instead of being written to disk
// for the game to crash on. The rules, verbatim from the server's own
// "Internal Error" log lines:
//   - user groups passwords must be unique
//   - only one user group can be without password
//   - a game role without password must not have more rights than a
//     password protected one
const USER_GROUP_RIGHT_FLAGS = [
  'canKickBan',
  'canAccessInventories',
  'canEditWorld',
  'canEditBase',
  'canExtendBase',
] as const

export function validateEnshroudedUserGroups(obj: JsonObject): string[] {
  const raw = obj['userGroups']
  if (!Array.isArray(raw)) return []
  const groups = raw.flatMap((g, i) => {
    if (!isPlainObject(g)) return []
    return {
      label: typeof g['name'] === 'string' && g['name'] ? `"${g['name']}"` : `#${i + 1}`,
      password: typeof g['password'] === 'string' ? g['password'] : '',
      rights: USER_GROUP_RIGHT_FLAGS.filter((f) => g[f] === true),
    }
  })
  const problems: string[] = []

  const byPassword = new Map<string, string[]>()
  for (const g of groups) {
    if (g.password === '') continue
    byPassword.set(g.password, [...(byPassword.get(g.password) ?? []), g.label])
  }
  for (const labels of byPassword.values()) {
    if (labels.length > 1) {
      problems.push(`groups ${labels.join(' and ')} share the same password — every group needs its own`)
    }
  }

  const open = groups.filter((g) => g.password === '')
  if (open.length > 1) {
    problems.push(
      `groups ${open.map((g) => g.label).join(' and ')} all have no password — at most one group may be passwordless`,
    )
  }
  for (const u of open) {
    for (const p of groups) {
      if (p.password === '') continue
      const extra = u.rights.filter((f) => !p.rights.includes(f))
      if (extra.length > 0) {
        problems.push(
          `passwordless group ${u.label} has rights (${extra.join(', ')}) that password-protected group ${p.label} lacks — give ${u.label} a password or make it the weakest role`,
        )
      }
    }
  }
  return problems
}

// Panel invariants, enforced LAST on every write: the registry's ports
// and the save/log dirs backups depend on. `gamePort` only when the key
// exists — newer server builds dropped it.
export function applyEnshroudedInvariants(obj: JsonObject, target: { gamePort: number; queryPort: number }): void {
  obj['ip'] = '0.0.0.0'
  obj['queryPort'] = target.queryPort
  if ('gamePort' in obj) obj['gamePort'] = target.gamePort
  obj['saveDirectory'] = `./${ENSHROUDED_SAVE_DIR}`
  obj['logDirectory'] = `./${ENSHROUDED_LOG_DIR}`
}

export function createEnshroudedSettings(env: Env, db: Db, target: JsonSettingsTarget): SettingsService {
  const jsonPath = path.join(target.installDir, ENSHROUDED_SERVER_JSON)

  function parseContent(content: string): JsonObject {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      throw new JsonParseError(
        `enshrouded_server.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!isPlainObject(parsed)) {
      throw new JsonParseError('enshrouded_server.json must be a JSON object')
    }
    return parsed
  }

  function readObject(): JsonObject {
    if (!fs.existsSync(jsonPath)) {
      throw new JsonParseError(
        'enshrouded_server.json not found — install the server and start it once so it generates its config.',
      )
    }
    return parseContent(fs.readFileSync(jsonPath, 'utf8'))
  }

  function writeObject(obj: JsonObject): void {
    applyEnshroudedInvariants(obj, target)
    const problems = validateEnshroudedUserGroups(obj)
    if (problems.length > 0) {
      throw new JsonParseError(
        `Enshrouded would refuse to start with these userGroups (it exits at boot and restarts in a loop): ${problems.join('; ')}. Adjust the group passwords, or edit userGroups in the raw editor (e.g. to remove a role or change its permissions).`,
      )
    }
    // Keep an undo copy, then temp-file + rename (atomic on same fs).
    const historyDir = path.join(env.DATA_DIR, 'ini-history', target.stateKey.replace(/[^a-zA-Z0-9_-]/g, '_'))
    fs.mkdirSync(historyDir, { recursive: true })
    if (fs.existsSync(jsonPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(jsonPath, path.join(historyDir, `enshrouded_server-${stamp}.json`))
      pruneHistory(historyDir, 20)
    }
    const tmp = `${jsonPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 4)}\n`, { mode: 0o640 })
    fs.renameSync(tmp, jsonPath)
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
      const obj = readObject()
      const entries: SettingsEntry[] = flattenScalars(obj).map(({ key, value }) => {
        const spec = ENSHROUDED_KEY_SPECS[key]
        return {
          key,
          raw: JSON.stringify(value),
          value: spec ? value : null,
          kind: spec?.kind ?? null,
          enumValues: spec?.enumValues ? [...spec.enumValues] : null,
          managed: spec?.managed ?? false,
          label: spec?.label ?? null,
          category: spec?.category ?? null,
        }
      })
      for (const g of userGroupPasswordEntries(obj)) {
        entries.push({
          key: g.key,
          raw: JSON.stringify(g.value),
          value: g.value,
          kind: 'string',
          enumValues: null,
          managed: false,
          label: g.label,
          category: 'Server & Network',
        })
      }
      return { entries, categories: [...ENSHROUDED_SETTINGS_CATEGORIES] }
    },

    writeStructured(values: Record<string, SettingValue>) {
      const obj = readObject()
      for (const [key, value] of Object.entries(values)) {
        if ((ENSHROUDED_MANAGED_KEYS as readonly string[]).includes(key)) {
          throw new JsonParseError(`${key} is panel-managed and cannot be edited`)
        }
        const groupName = USER_GROUP_PASSWORD_RE.exec(key)?.[1]
        if (groupName !== undefined) {
          setUserGroupPassword(obj, groupName, String(value))
          continue
        }
        const spec = ENSHROUDED_KEY_SPECS[key]
        if (spec) {
          if (spec.kind === 'enum' && spec.enumValues && !spec.enumValues.includes(String(value))) {
            throw new JsonParseError(`${key} must be one of: ${spec.enumValues.join(', ')}`)
          }
          const coerced =
            spec.kind === 'int'
              ? Math.trunc(Number(value))
              : spec.kind === 'float'
                ? Number(value)
                : spec.kind === 'bool'
                  ? value === true || value === 'true' || value === 'True'
                  : String(value)
          if ((spec.kind === 'int' || spec.kind === 'float') && !Number.isFinite(coerced as number)) {
            throw new JsonParseError(`${key} must be a number`)
          }
          setPath(obj, key, coerced)
        } else if (isScalar(getPath(obj, key))) {
          // Unknown-but-present scalar: accept a JSON scalar literal only
          // (mirrors the INI adapter's verbatim unknown-key rule).
          if (typeof value !== 'string') {
            throw new JsonParseError(`${key} is not a known setting; provide its raw JSON value`)
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(value)
          } catch {
            throw new JsonParseError(`${key}: value must be a JSON scalar literal`)
          }
          if (!isScalar(parsed)) {
            throw new JsonParseError(`${key}: value must be a JSON scalar literal`)
          }
          setPath(obj, key, parsed)
        } else {
          throw new JsonParseError(`${key} is not a known setting and not present in the file`)
        }
      }
      writeObject(obj)
    },

    readRaw() {
      if (!fs.existsSync(jsonPath)) {
        throw new JsonParseError(
          'enshrouded_server.json not found — install the server and start it once so it generates its config.',
        )
      }
      return fs.readFileSync(jsonPath, 'utf8')
    },

    writeRaw(content: string) {
      writeObject(parseContent(content)) // throws JsonParseError on garbage
    },

    seedIfMissing() {
      if (fs.existsSync(jsonPath)) return
      // Minimal template — the server fills in the full gameSettings and
      // userGroups on first boot. writeObject applies the invariants.
      fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
      writeObject({
        name: 'Rallypoint Enshrouded',
        saveDirectory: `./${ENSHROUDED_SAVE_DIR}`,
        logDirectory: `./${ENSHROUDED_LOG_DIR}`,
        ip: '0.0.0.0',
        queryPort: target.queryPort,
        slotCount: 16,
        gameSettingsPreset: 'Default',
      })
      // A brand-new seed isn't a pending edit against a running server.
      setPending(false)
    },

    getPendingRestart() {
      const row = db
        .select({ value: panelState.value })
        .from(panelState)
        .where(eq(panelState.key, target.stateKey))
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

function pruneHistory(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  while (files.length > keep) {
    const oldest = files.shift()
    if (oldest) fs.unlinkSync(path.join(dir, oldest))
  }
}
