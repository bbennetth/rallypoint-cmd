import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { GameKeySpec, SettingValue, SettingsEntry } from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Db } from '../db/client.js'
import { panelState } from '../db/schema/index.js'
import { SettingsParseError, coerceValue, type SettingsService } from './settings-ini.js'
import { invalidateAdminCredsCache } from './admin-creds.js'
import type { SettingsDoc, SettingsFormat } from './settings-formats.js'

// The generic settings engine: one SettingsService built from a file
// format (settings-formats.ts) plus a per-game spec table and invariants
// (game-settings-configs.ts). Palworld and Enshrouded keep their own
// hand-written services — their files are structurally unlike anything
// else — but every game after them lands here.
//
// The engine owns what must not vary per game: atomic writes, an undo
// history, the pending-restart flag, refusing edits to panel-managed
// keys, and re-asserting the panel's invariants on every single write
// (structured or raw) so the admin channel can never be edited shut.

export interface GameSettingsConfig {
  slug: string
  // Config file, relative to the install dir.
  file: string
  format: SettingsFormat
  specs: Record<string, GameKeySpec>
  categories: readonly string[]
  // Keys the panel owns; rejected in structured writes and re-applied
  // after every write.
  managedKeys: readonly string[]
  // Re-assert the panel's control-channel keys. Runs last on every write
  // and on seed, so a hand-edited file is corrected rather than trusted.
  applyInvariants(doc: SettingsDoc): void
  // Written verbatim when the file is missing after an install. Games
  // that ship their own config (7DTD) return null and are corrected in
  // place instead.
  seedContent?(): string | null
}

export interface FileSettingsConfigTarget {
  installDir: string
  // panel_state key tracking this instance's pending-restart flag.
  stateKey: string
}

// Values are rendered plainly here — quoting is the format's business,
// not the value's, which is what lets one spec table serve an ini, an
// XML property and a console command alike.
function renderValue(kind: string, value: SettingValue): string {
  switch (kind) {
    case 'bool':
      return value === true || value === 'true' || value === 'True' ? 'true' : 'false'
    case 'int':
      return String(Math.trunc(Number(value)))
    case 'float':
      return String(Number(value))
    default:
      return String(value)
  }
}

export function createFileSettings(
  env: Env,
  db: Db,
  config: GameSettingsConfig,
  target: FileSettingsConfigTarget,
): SettingsService {
  const filePath = path.join(target.installDir, config.file)

  function readContent(): string {
    if (!fs.existsSync(filePath)) {
      throw new SettingsParseError(`${path.basename(config.file)} not found — is the server installed?`)
    }
    return fs.readFileSync(filePath, 'utf8')
  }

  function writeContent(content: string): void {
    const historyDir = path.join(env.DATA_DIR, 'settings-history', target.stateKey.replace(/[^a-zA-Z0-9_-]/g, '_'))
    fs.mkdirSync(historyDir, { recursive: true })
    const base = path.basename(config.file)
    if (fs.existsSync(filePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(filePath, path.join(historyDir, `${base}-${stamp}`))
      pruneHistory(historyDir, base, 20)
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, { mode: 0o640 })
    fs.renameSync(tmp, filePath)
    // The admin password/port may have just changed under the RCON
    // clients — drop the cached copy so the next command re-reads it.
    invalidateAdminCredsCache(target.installDir)
    setPending(true)
  }

  // Parse, mutate, re-assert invariants, write. The single path every
  // write goes through, so no caller can skip the invariants.
  function commit(doc: SettingsDoc): void {
    config.applyInvariants(doc)
    writeContent(config.format.serialize(doc))
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
      const doc = config.format.parse(readContent())
      const entries: SettingsEntry[] = [...doc.entries.entries()].map(([key, raw]) => {
        const spec = config.specs[key]
        return {
          key,
          raw,
          value: spec ? coerceValue(spec.kind, raw) : null,
          kind: spec?.kind ?? null,
          enumValues: spec?.enumValues ? [...spec.enumValues] : null,
          managed: spec?.managed ?? config.managedKeys.includes(key),
          label: spec?.label ?? null,
          category: spec?.category ?? null,
        }
      })
      // A managed key the file does not carry yet still belongs in the
      // form — it is about to exist, and the operator should see it.
      for (const key of config.managedKeys) {
        if (doc.entries.has(key)) continue
        const spec = config.specs[key]
        if (!spec) continue
        entries.push({
          key,
          raw: '',
          value: null,
          kind: spec.kind,
          enumValues: spec.enumValues ? [...spec.enumValues] : null,
          managed: true,
          label: spec.label ?? null,
          category: spec.category,
        })
      }
      return { entries, categories: [...config.categories] }
    },

    writeStructured(values) {
      const doc = config.format.parse(readContent())
      for (const [key, value] of Object.entries(values)) {
        if (config.managedKeys.includes(key)) {
          throw new SettingsParseError(`${key} is panel-managed and cannot be edited`)
        }
        const spec = config.specs[key]
        if (spec) {
          if (spec.kind === 'enum' && spec.enumValues && !spec.enumValues.includes(String(value))) {
            throw new SettingsParseError(`${key} must be one of: ${spec.enumValues.join(', ')}`)
          }
          config.format.set(doc, key, renderValue(spec.kind, value))
        } else if (doc.entries.has(key)) {
          // Unknown-but-present key: accept a verbatim raw string only.
          if (typeof value !== 'string') {
            throw new SettingsParseError(`${key} is not a known setting; provide its raw string value`)
          }
          config.format.set(doc, key, value)
        } else {
          throw new SettingsParseError(`${key} is not a known setting and not present in the file`)
        }
      }
      commit(doc)
    },

    readRaw() {
      return readContent()
    },

    writeRaw(content) {
      // Parsing validates; invariants then correct whatever the operator
      // changed about the panel's own keys.
      commit(config.format.parse(content))
    },

    seedIfMissing() {
      if (fs.existsSync(filePath)) {
        // The file exists but may predate the panel (or a restore may
        // have brought back an older one) — re-assert the invariants so
        // the admin channel is live before the game next starts.
        try {
          commit(config.format.parse(fs.readFileSync(filePath, 'utf8')))
        } catch {
          // A config we cannot parse is left alone; the settings page
          // surfaces the parse error rather than the panel rewriting it.
        }
        return
      }
      const seed = config.seedContent?.()
      if (seed === null || seed === undefined) return
      const doc = config.format.parse(seed)
      config.applyInvariants(doc)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, config.format.serialize(doc), { mode: 0o640 })
      invalidateAdminCredsCache(target.installDir)
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

function pruneHistory(dir: string, base: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}-`))
    .sort()
  while (files.length > keep) {
    const oldest = files.shift()
    if (oldest) fs.unlinkSync(path.join(dir, oldest))
  }
}
