import { randomBytes } from 'node:crypto'
import {
  ARK_KEY_SPECS,
  ARK_SETTINGS_CATEGORIES,
  RUST_KEY_SPECS,
  RUST_SETTINGS_CATEGORIES,
  SDTD_KEY_SPECS,
  SDTD_SETTINGS_CATEGORIES,
  SOURCE_CFG_KEY_SPECS,
  SOURCE_CFG_SETTINGS_CATEGORIES,
  UNTURNED_KEY_SPECS,
  UNTURNED_SETTINGS_CATEGORIES,
  VALHEIM_KEY_SPECS,
  VALHEIM_SETTINGS_CATEGORIES,
  ZOMBOID_KEY_SPECS,
  ZOMBOID_SETTINGS_CATEGORIES,
  gameBySlug,
  type GameDef,
} from '@rallypoint-cmd/shared'
import type { Env } from '../env.js'
import type { Db } from '../db/client.js'
import { SettingsParseError, type SettingsService } from './settings-ini.js'
import {
  createCompositeSettings,
  createFileSettings,
  type FileSettingsConfigTarget,
  type GameSettingsConfig,
} from './settings-file.js'
import {
  SOURCE_CFG_DIALECT,
  UNTURNED_DIALECT,
  ZOMBOID_DIALECT,
  keyValueFormat,
  launchConfFormat,
  renderLaunchConfSeed,
  sectionedIniFormat,
  xmlPropertiesFormat,
  type SettingsDoc,
} from './settings-formats.js'

// Per-game settings wiring: which file, which dialect, which spec table,
// and — the part that matters — what the panel enforces on every write.
//
// The invariants are the same idea as Palworld's REST credentials: the
// panel administers each game over a channel the game itself is
// configured to expose, so the keys that open that channel are owned by
// the panel. An operator can read them but not edit them shut, and a
// hand-edited or restored config is corrected on the next write.

// Generated once and then left alone: rewriting it on every write would
// invalidate a password an operator may have shared with their admins.
function generatedSecret(): string {
  return randomBytes(18).toString('base64url')
}

// Set a key to a fixed value, always.
function pin(doc: SettingsDoc, format: GameSettingsConfig['format'], key: string, value: string): void {
  if (doc.entries.get(key) !== value) format.set(doc, key, value)
}

// Set a key only if it has no usable value yet.
function ensureSecret(doc: SettingsDoc, format: GameSettingsConfig['format'], key: string): void {
  const current = doc.entries.get(key)
  if (!current || current.trim() === '') format.set(doc, key, generatedSecret())
}

function portOf(game: GameDef, name: string, fallback: number): number {
  return game.ports.find((p) => p.name === name)?.port ?? fallback
}

// --- ARK: Survival Evolved -------------------------------------------
// GameUserSettings.ini exists only after the first boot, so the panel
// seeds a minimal one — otherwise there is no way to enable RCON before
// the server has already started without it.

function arkConfig(game: GameDef): GameSettingsConfig {
  const rconPort = portOf(game, 'rcon', 27020)
  return {
    slug: game.slug,
    file: 'ShooterGame/Saved/Config/LinuxServer/GameUserSettings.ini',
    format: sectionedIniFormat,
    specs: ARK_KEY_SPECS,
    categories: ARK_SETTINGS_CATEGORIES,
    managedKeys: ['ServerSettings/RCONEnabled', 'ServerSettings/RCONPort', 'ServerSettings/ServerAdminPassword'],
    applyInvariants(doc) {
      pin(doc, sectionedIniFormat, 'ServerSettings/RCONEnabled', 'True')
      pin(doc, sectionedIniFormat, 'ServerSettings/RCONPort', String(rconPort))
      ensureSecret(doc, sectionedIniFormat, 'ServerSettings/ServerAdminPassword')
    },
    seedContent: () => ['[ServerSettings]', '[SessionSettings]', '[/Script/Engine.GameSession]', ''].join('\n'),
  }
}

// --- 7 Days to Die ----------------------------------------------------
// Ships its own serverconfig.xml, so there is nothing to seed — the
// panel corrects the shipped file in place to open the telnet console.

function sevenDaysConfig(game: GameDef): GameSettingsConfig {
  const telnetPort = portOf(game, 'telnet', 8081)
  return {
    slug: game.slug,
    file: 'serverconfig.xml',
    format: xmlPropertiesFormat,
    specs: SDTD_KEY_SPECS,
    categories: SDTD_SETTINGS_CATEGORIES,
    managedKeys: ['TelnetEnabled', 'TelnetPort', 'TelnetPassword', 'SaveGameFolder', 'UserDataFolder'],
    applyInvariants(doc) {
      pin(doc, xmlPropertiesFormat, 'TelnetEnabled', 'true')
      pin(doc, xmlPropertiesFormat, 'TelnetPort', String(telnetPort))
      ensureSecret(doc, xmlPropertiesFormat, 'TelnetPassword')
      // The backup contract reads a fixed save root, so the game must not
      // be pointed somewhere else — a moved save dir would back up an
      // empty tree and restore where the game no longer looks.
      for (const key of ['SaveGameFolder', 'UserDataFolder']) {
        if ((doc.entries.get(key) ?? '') !== '') xmlPropertiesFormat.set(doc, key, '')
      }
    },
  }
}

// --- Project Zomboid --------------------------------------------------
// The ini is named after the server identity the unit launches with
// (`-servername rallypoint`), and is generated on first boot.

function zomboidConfig(game: GameDef): GameSettingsConfig {
  const rconPort = portOf(game, 'rcon', 27025)
  const format = keyValueFormat(ZOMBOID_DIALECT)
  return {
    slug: game.slug,
    file: 'Zomboid/Server/rallypoint.ini',
    format,
    specs: ZOMBOID_KEY_SPECS,
    categories: ZOMBOID_SETTINGS_CATEGORIES,
    managedKeys: ['RCONPort', 'RCONPassword'],
    applyInvariants(doc) {
      pin(doc, format, 'RCONPort', String(rconPort))
      ensureSecret(doc, format, 'RCONPassword')
    },
    seedContent: () => ['# Generated by rallypoint-cmd on first install.', 'PublicName=Rallypoint', ''].join('\n'),
  }
}

// --- Source dedicated servers (TF2, CS2) ------------------------------
// server.cfg is executed at map load and is the single home of the RCON
// password. CS2 also accepts +rcon_password on the command line, but
// setting it in both places means two generated secrets and no way to
// know which one the server ended up with — a password the panel cannot
// predict is worse than one that arrives at map load.

function sourceConfig(game: GameDef, file: string): GameSettingsConfig {
  const format = keyValueFormat(SOURCE_CFG_DIALECT)
  // Keys that must reach the game as launch arguments are stored in the
  // launch conf, so they must not also be offered here — one setting
  // written to two files is a setting nobody can predict the value of.
  const launchOwned = new Set(LAUNCH_EDITABLE_KEYS[game.slug] ?? [])
  const specs = Object.fromEntries(
    Object.entries(SOURCE_CFG_KEY_SPECS).filter(([key]) => !launchOwned.has(key)),
  )
  return {
    slug: game.slug,
    file,
    format,
    specs,
    categories: SOURCE_CFG_SETTINGS_CATEGORIES,
    managedKeys: ['rcon_password'],
    applyInvariants(doc) {
      ensureSecret(doc, format, 'rcon_password')
    },
    seedContent: () =>
      ['// Generated by rallypoint-cmd on first install.', 'hostname "Rallypoint Server"', ''].join('\n'),
  }
}

// --- Unturned ---------------------------------------------------------
// Commands.dat is a list of console commands run at boot; the panel pins
// the port the unit was provisioned with.

function unturnedConfig(game: GameDef): GameSettingsConfig {
  const format = keyValueFormat(UNTURNED_DIALECT)
  // Unturned's `Port` setting is its query/base port; game traffic runs
  // on Port + 1 (see the registry entry).
  const basePort = portOf(game, 'query', 27015)
  return {
    slug: game.slug,
    file: 'Servers/rallypoint/Server/Commands.dat',
    format,
    specs: UNTURNED_KEY_SPECS,
    categories: UNTURNED_SETTINGS_CATEGORIES,
    managedKeys: ['port'],
    applyInvariants(doc) {
      pin(doc, format, 'port', String(basePort))
    },
    seedContent: () => ['Name Rallypoint', 'MaxPlayers 24', ''].join('\n'),
  }
}

// --- Valheim (launch args only) ---------------------------------------
// Valheim has no config file at all, so the panel owns a launch conf
// that start.sh dot-sources. That makes the settings page possible and
// is why launch-conf values are charset-restricted (settings-formats.ts).

function valheimConfig(game: GameDef): GameSettingsConfig {
  const gamePort = portOf(game, 'game', 2456)
  return {
    slug: game.slug,
    file: game.launchConfFile ?? 'rallypoint-launch.conf',
    format: launchConfFormat,
    specs: VALHEIM_KEY_SPECS,
    categories: VALHEIM_SETTINGS_CATEGORIES,
    managedKeys: ['-port'],
    applyInvariants(doc) {
      // `-crossplay` is a valueless flag: present means on. Rendering it
      // as `-crossplay false` would switch crossplay ON, the opposite of
      // what the operator asked for.
      const crossplay = doc.entries.get('-crossplay')
      if (crossplay !== undefined) {
        if (crossplay === 'true' || crossplay === '') doc.entries.set('-crossplay', '')
        else doc.entries.delete('-crossplay')
      }
      pin(doc, launchConfFormat, '-port', String(gamePort))
      // Valheim refuses to start with a password shorter than 5 chars,
      // and refuses one at all unless the server is listed publicly.
      const password = doc.entries.get('-password') ?? ''
      if (password !== '' && password.length < 5) {
        throw new SettingsParseError('Valheim join passwords must be at least 5 characters (or empty).')
      }
      const serverName = doc.entries.get('-name') ?? ''
      const worldName = doc.entries.get('-world') ?? ''
      if (password !== '' && (serverName.includes(password) || worldName.includes(password))) {
        throw new SettingsParseError(
          'Valheim refuses a join password that appears inside the server name or world name.',
        )
      }
    },
    seedContent: () =>
      renderLaunchConfSeed({ '-name': 'Rallypoint', '-world': 'Dedicated', '-public': '0' }),
  }
}

// --- Rust -------------------------------------------------------------
// Gameplay convars live in server.cfg; the RCON convars only take effect
// from the command line, so they live in the launch conf instead and are
// managed there (see admin-creds.ts, which reads them back).

function rustConfig(game: GameDef): GameSettingsConfig {
  const format = keyValueFormat(SOURCE_CFG_DIALECT)
  return {
    slug: game.slug,
    file: 'server/rallypoint/cfg/server.cfg',
    format,
    specs: RUST_KEY_SPECS,
    categories: RUST_SETTINGS_CATEGORIES,
    managedKeys: [],
    applyInvariants() {
      // Nothing panel-critical lives in server.cfg for Rust — the admin
      // channel is configured through the launch conf.
    },
    seedContent: () =>
      ['// Generated by rallypoint-cmd on first install.', 'server.hostname "Rallypoint Rust"', ''].join('\n'),
  }
}

// The launch conf a game needs alongside its main settings file, for
// settings the game only accepts on the command line. Two games have one:
// Rust (its RCON convars are ignored in server.cfg) and Project Zomboid
// (its first-boot admin prompt has to be answered before there is a
// console to answer it on).
// Keys an operator edits that must reach the game as launch arguments.
// They render on the settings page like any other key; only their storage
// differs (see createCompositeSettings).
export const LAUNCH_EDITABLE_KEYS: Record<string, readonly string[]> = {
  'team-fortress-2': ['+sv_setsteamaccount'],
  'counter-strike-2': ['+sv_setsteamaccount'],
}

const LAUNCH_ONLY_INVARIANTS: Record<
  string,
  { managedKeys: readonly string[]; apply(doc: SettingsDoc, game: GameDef): void }
> = {
  rust: {
    managedKeys: ['+rcon.port', '+rcon.password', '+rcon.web', '+server.queryport'],
    apply(doc, game) {
      pin(doc, launchConfFormat, '+rcon.port', String(portOf(game, 'rcon', 28016)))
      pin(doc, launchConfFormat, '+rcon.web', '1')
      ensureSecret(doc, launchConfFormat, '+rcon.password')
      // Left unset, Rust derives this as max(server.port, rcon.port) + 1
      // and the panel would query a port nothing is listening on.
      pin(doc, launchConfFormat, '+server.queryport', String(portOf(game, 'query', 28017)))
    },
  },
  'project-zomboid': {
    managedKeys: ['-adminusername', '-adminpassword'],
    apply(doc) {
      // Answers the first-boot prompt that would otherwise hang the unit
      // forever. Ignored by the game once the admin account exists. This
      // is the game's admin *account*, distinct from its RCON password.
      pin(doc, launchConfFormat, '-adminusername', 'admin')
      ensureSecret(doc, launchConfFormat, '-adminpassword')
    },
  },
}

export function launchConfConfigFor(game: GameDef): GameSettingsConfig | null {
  if (!game.launchConfFile || game.settingsAdapter === 'launch-conf') return null
  const invariants = LAUNCH_ONLY_INVARIANTS[game.slug]
  const editable = LAUNCH_EDITABLE_KEYS[game.slug] ?? []
  if (!invariants && editable.length === 0) return null
  const specs = Object.fromEntries(
    editable.filter((key) => key in SOURCE_CFG_KEY_SPECS).map((key) => [key, SOURCE_CFG_KEY_SPECS[key]!]),
  )
  return {
    slug: game.slug,
    file: game.launchConfFile,
    format: launchConfFormat,
    specs,
    categories: [...SOURCE_CFG_SETTINGS_CATEGORIES],
    managedKeys: invariants?.managedKeys ?? [],
    applyInvariants(doc) {
      invariants?.apply(doc, game)
    },
    seedContent: () => '',
  }
}

const BUILDERS: Record<string, (game: GameDef) => GameSettingsConfig> = {
  valheim: valheimConfig,
  rust: rustConfig,
  'ark-survival-evolved': arkConfig,
  '7-days-to-die': sevenDaysConfig,
  'project-zomboid': zomboidConfig,
  'team-fortress-2': (game) => sourceConfig(game, 'tf/cfg/server.cfg'),
  'counter-strike-2': (game) => sourceConfig(game, 'game/csgo/cfg/server.cfg'),
  unturned: unturnedConfig,
}

// Slug → config, for tests and for callers holding a slug. Configs exist
// ahead of the registry flipping each game's settingsAdapter on.
export function settingsConfigForSlug(slug: string): GameSettingsConfig | null {
  const game = gameBySlug(slug)
  const build = BUILDERS[slug]
  return game && build ? build(game) : null
}

// The settings service for a game the generic engine owns; null for
// Palworld, Enshrouded and games with no settings file (compose keeps
// their hand-written services and the null adapter respectively).
export function createSettingsFor(
  env: Env,
  db: Db,
  game: GameDef,
  target: FileSettingsConfigTarget,
): SettingsService | null {
  const build = BUILDERS[game.slug]
  if (!build) return null
  const primary = createFileSettings(env, db, build(game), target)
  const editable = LAUNCH_EDITABLE_KEYS[game.slug]
  const launchConf = editable?.length ? launchConfConfigFor(game) : null
  if (!launchConf || !editable) return primary
  return createCompositeSettings(primary, {
    service: createFileSettings(env, db, launchConf, target),
    keys: editable,
  })
}
