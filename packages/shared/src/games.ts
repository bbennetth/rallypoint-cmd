// Data-driven game registry. Every game the panel can manage is an entry
// here; server-side services and the web UI both derive behavior from the
// entry rather than hardcoding any one game. Adding a game is a data
// change — the systemd start script and per-instance drop-in are
// rendered from this registry at provision time (unit-provision.ts).
//
// Invariant: every entry is installable with `steamcmd +login anonymous`
// (no Steam account) and is either a native Linux dedicated server or a
// Windows-only one run under Wine (`platform: 'windows'`).

export type SettingsAdapterKind =
  | 'palworld-ini' // Palworld PalWorldSettings.ini (UE tuple line)
  | 'enshrouded-json' // Enshrouded enshrouded_server.json
  | 'sectioned-ini' // [Section] Key=Value files (ARK GameUserSettings.ini)
  | 'xml-properties' // flat <property name= value=/> XML (7DTD serverconfig.xml)
  | 'keyvalue-ini' // flat Key=Value lines (Project Zomboid server ini)
  | 'source-cfg' // "cvar value" lines (Source server.cfg, Rust server.cfg)
  | 'launch-conf' // panel-owned launch-arg file sourced by start.sh (Valheim)
  | 'unturned-commands' // Unturned Commands.dat ("command value" lines)
  | 'none'
export type QueryKind = 'pal-rest' | 'a2s' | 'satisfactory-lwq' | 'none'
// How the panel administers players (list/kick/ban/announce/save).
// 'rcon' = Source RCON over TCP; 'webrcon' = Rust's WebSocket RCON;
// 'telnet' = 7 Days to Die's line-based telnet console.
export type PlayersKind = 'pal-rest' | 'rcon' | 'webrcon' | 'telnet' | 'none'
export type ModsKind = 'ue-paks' | 'none'

export interface GamePort {
  name: string
  port: number
  proto: 'udp' | 'tcp'
  // The port players actually connect through, when it is not the one
  // named 'game' (Enshrouded joins happen over its Steam query port).
  join?: boolean
}

export interface GameDef {
  slug: string
  name: string
  steamAppId: number
  // 'windows' = the dedicated server ships a Windows-only binary:
  // steamcmd installs the Windows depot (+@sSteamCmdForcePlatformType
  // windows) and the generated start.sh runs it under Wine. Absent =
  // native Linux.
  platform?: 'windows'
  // Command line run from the install dir by the generated start.sh.
  startCommand: { bin: string; args: string[] }
  stopSignal: 'SIGINT' | 'SIGTERM'
  timeoutStopSec: number
  memoryHigh?: string
  memoryMax?: string
  ports: GamePort[]
  // Dirs (relative to the install dir) that hold world/save state.
  savePaths: string[]
  // File (relative to the install dir) whose presence means "installed".
  installedProbe: string
  settingsAdapter: SettingsAdapterKind
  // Panel-owned launch-arg file (relative to the install dir) sourced by
  // the generated start.sh when present. Written only by the launch-conf
  // settings machinery, which enforces a strict value charset — start.sh
  // dot-sources this file, so free-form content must never reach it.
  launchConfFile?: string
  capabilities: {
    query: QueryKind
    players: PlayersKind
    mods: ModsKind
    // Palworld-style named-world semantics (32-hex world id) — gates the
    // backup/restore engine, whose archive contract assumes them.
    world: boolean
  }
  // Regex sources (case-insensitive, matched against console lines) that
  // mark a line as worth surfacing on the Monitoring page. Omit to take
  // DEFAULT_ERROR_PATTERNS; set it when a game names its own trouble in
  // words the default set would miss.
  logPatterns?: { error: string[] }
  // Rough full-install size, surfaced in the add-server UI.
  diskEstimateGb: number
  // 'full' = everything the game itself allows is wired (settings,
  // query, player admin, backups — which of those exist varies by game;
  // see `capabilities`). 'basic' = install, start/stop, console, updates
  // and restart schedules only.
  supportLevel: 'full' | 'basic'
}

export const GAMES: Record<string, GameDef> = {
  palworld: {
    slug: 'palworld',
    name: 'Palworld',
    steamAppId: 2394010,
    startCommand: {
      bin: './PalServer.sh',
      args: ['-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 90,
    memoryHigh: '22G',
    memoryMax: '24G',
    ports: [
      { name: 'game', port: 8211, proto: 'udp' },
      { name: 'rest', port: 8212, proto: 'tcp' },
    ],
    savePaths: ['Pal/Saved/SaveGames/0'],
    installedProbe: 'PalServer.sh',
    settingsAdapter: 'palworld-ini',
    capabilities: { query: 'pal-rest', players: 'pal-rest', mods: 'ue-paks', world: true },
    diskEstimateGb: 12,
    supportLevel: 'full',
  },
  valheim: {
    slug: 'valheim',
    name: 'Valheim',
    steamAppId: 896660,
    startCommand: {
      bin: './valheim_server.x86_64',
      // Name, world, port and visibility come from the launch conf the
      // settings editor owns — keeping them here too would pass every
      // flag twice.
      args: ['-nographics', '-batchmode'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 60,
    memoryHigh: '4G',
    memoryMax: '6G',
    ports: [
      { name: 'game', port: 2456, proto: 'udp' },
      // Valheim answers Steam queries on game port + 1.
      { name: 'query', port: 2457, proto: 'udp' },
    ],
    savePaths: ['.config/unity3d/IronGate/Valheim/worlds_local'],
    installedProbe: 'valheim_server.x86_64',
    // No config file at all — every knob is a launch flag, so the panel
    // owns a conf that the generated start.sh sources.
    settingsAdapter: 'launch-conf',
    launchConfFile: 'rallypoint-launch.conf',
    // Vanilla Valheim has no admin console to drive: moderation happens
    // through adminlist.txt, not a live protocol.
    capabilities: { query: 'a2s', players: 'none', mods: 'none', world: true },
    diskEstimateGb: 2,
    supportLevel: 'full',
  },
  rust: {
    slug: 'rust',
    name: 'Rust',
    steamAppId: 258550,
    startCommand: {
      bin: './RustDedicated',
      args: ['-batchmode', '+server.port', '28015', '+server.identity', 'rallypoint', '+server.maxplayers', '50'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 120,
    ports: [
      { name: 'game', port: 28015, proto: 'udp' },
      // Rust derives its query port as max(server.port, rcon.port) + 1
      // unless told otherwise; the launch conf pins it to match.
      { name: 'query', port: 28017, proto: 'udp' },
      { name: 'rcon', port: 28016, proto: 'tcp' },
    ],
    savePaths: ['server/rallypoint'],
    installedProbe: 'RustDedicated',
    settingsAdapter: 'source-cfg',
    // Rust honors its RCON convars only from the command line, so the
    // panel keeps those in a launch conf rather than server.cfg.
    launchConfFile: 'rallypoint-launch.conf',
    // Rust's RCON is a WebSocket protocol of its own, not Source RCON.
    capabilities: { query: 'a2s', players: 'webrcon', mods: 'none', world: true },
    diskEstimateGb: 35,
    supportLevel: 'full',
  },
  'ark-survival-evolved': {
    slug: 'ark-survival-evolved',
    name: 'ARK: Survival Evolved',
    steamAppId: 376030,
    startCommand: {
      bin: './ShooterGame/Binaries/Linux/ShooterGameServer',
      args: ['TheIsland?listen?SessionName=Rallypoint', '-server', '-log'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 120,
    ports: [
      { name: 'game', port: 7777, proto: 'udp' },
      // Steam P2P peer port — required for the in-game browser.
      { name: 'peer', port: 7778, proto: 'udp' },
      { name: 'query', port: 27015, proto: 'udp' },
      { name: 'rcon', port: 27020, proto: 'tcp' },
    ],
    // Only the world saves; the panel-managed ini rides along with the
    // backup as a config file (see backup-contracts.ts).
    savePaths: ['ShooterGame/Saved/SavedArks'],
    installedProbe: 'ShooterGame/Binaries/Linux/ShooterGameServer',
    settingsAdapter: 'sectioned-ini',
    capabilities: { query: 'a2s', players: 'rcon', mods: 'none', world: true },
    diskEstimateGb: 100,
    supportLevel: 'full',
  },
  '7-days-to-die': {
    slug: '7-days-to-die',
    name: '7 Days to Die',
    steamAppId: 294420,
    startCommand: {
      bin: './7DaysToDieServer.x86_64',
      args: ['-configfile=serverconfig.xml', '-logfile', '/dev/stdout', '-quit', '-batchmode', '-nographics', '-dedicated'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 120,
    ports: [
      { name: 'game', port: 26900, proto: 'udp' },
      { name: 'query', port: 26901, proto: 'udp' },
      { name: 'game-alt', port: 26902, proto: 'udp' },
      { name: 'telnet', port: 8081, proto: 'tcp' },
    ],
    savePaths: ['.local/share/7DaysToDie/Saves'],
    installedProbe: '7DaysToDieServer.x86_64',
    settingsAdapter: 'xml-properties',
    // No RCON — 7DTD's admin channel is its telnet console.
    capabilities: { query: 'a2s', players: 'telnet', mods: 'none', world: true },
    diskEstimateGb: 15,
    supportLevel: 'full',
  },
  'project-zomboid': {
    slug: 'project-zomboid',
    name: 'Project Zomboid',
    steamAppId: 380870,
    startCommand: {
      bin: './start-server.sh',
      // -cachedir is required, not cosmetic: Project Zomboid is a JVM
      // app and the JVM reads `user.home` from the passwd entry, not
      // $HOME — so the panel's HOME override does NOT move its data.
      // Without this the server writes to the service account's real
      // home and the panel backs up an empty tree.
      args: ['-servername', 'rallypoint', '-cachedir={{INSTALL_DIR}}/Zomboid'],
    },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 120,
    ports: [
      { name: 'game', port: 16261, proto: 'udp' },
      { name: 'query', port: 16261, proto: 'udp' },
      { name: 'game-alt', port: 16262, proto: 'udp' },
      // Deconflicted from the Source games' 27015 block.
      { name: 'rcon', port: 27025, proto: 'tcp' },
    ],
    // One swap covers Saves/ and the player DB together; Logs/ and the
    // panel-managed Server/ ini are excluded by the world contract.
    savePaths: ['Zomboid'],
    installedProbe: 'start-server.sh',
    settingsAdapter: 'keyvalue-ini',
    // Project Zomboid stops at an interactive prompt on first boot asking
    // for an admin password. Under systemd there is no TTY to answer it,
    // so the unit would simply never come up — the launch conf carries
    // `-adminpassword` to bypass the prompt.
    launchConfFile: 'rallypoint-launch.conf',
    capabilities: { query: 'a2s', players: 'rcon', mods: 'none', world: true },
    diskEstimateGb: 5,
    supportLevel: 'full',
  },
  satisfactory: {
    slug: 'satisfactory',
    name: 'Satisfactory',
    steamAppId: 1690800,
    startCommand: { bin: './FactoryServer.sh', args: [] },
    stopSignal: 'SIGINT',
    timeoutStopSec: 90,
    ports: [
      { name: 'game', port: 7777, proto: 'udp' },
      { name: 'game-tcp', port: 7777, proto: 'tcp' },
      // Reliable Messaging port, required since Patch 1.1.
      { name: 'messaging', port: 8888, proto: 'tcp' },
    ],
    // HOME is the install dir, so the Epic save tree lands under it.
    savePaths: ['.config/Epic/FactoryGame/Saved/SaveGames'],
    installedProbe: 'FactoryServer.sh',
    // Settings are administered in-game through an HTTPS API that needs
    // a claim token the panel can't self-provision — no file to edit.
    settingsAdapter: 'none',
    // Answers its own lightweight query protocol on the game port rather
    // than A2S; that protocol carries no player counts.
    capabilities: { query: 'satisfactory-lwq', players: 'none', mods: 'none', world: true },
    diskEstimateGb: 15,
    supportLevel: 'full',
  },
  'team-fortress-2': {
    slug: 'team-fortress-2',
    name: 'Team Fortress 2',
    steamAppId: 232250,
    // -maxplayers is a dash argument; `+maxplayers` is not a console
    // command and is silently ignored.
    startCommand: {
      bin: './srcds_run',
      // -norestart makes srcds_run exec the engine instead of supervising
      // it in a relaunch loop: without it the panel's stop signal reaches
      // only the wrapper, and a server it did stop comes back 10s later.
      args: ['-game', 'tf', '-norestart', '+map', 'cp_dustbowl', '-maxplayers', '24'],
    },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 30,
    ports: [
      { name: 'game', port: 27015, proto: 'udp' },
      { name: 'query', port: 27015, proto: 'udp' },
      { name: 'rcon', port: 27015, proto: 'tcp' },
      { name: 'sourcetv', port: 27020, proto: 'udp' },
    ],
    savePaths: ['tf/cfg'],
    installedProbe: 'srcds_run',
    settingsAdapter: 'source-cfg',
    // Carries the Steam login token, which must be set before the server
    // logs in — server.cfg runs at map load, too late for it.
    launchConfFile: 'rallypoint-launch.conf',
    // No persistent world to back up — a Source server's state is its
    // config, which the settings editor already covers.
    capabilities: { query: 'a2s', players: 'rcon', mods: 'none', world: false },
    diskEstimateGb: 25,
    supportLevel: 'full',
  },
  'counter-strike-2': {
    slug: 'counter-strike-2',
    name: 'Counter-Strike 2',
    steamAppId: 730,
    startCommand: {
      // Valve's docs are explicit that the wrapper must be used rather
      // than game/bin/linuxsteamrt64/cs2 directly: it sets
      // LD_LIBRARY_PATH and raises the fd/stack ulimits the engine needs.
      bin: './game/cs2.sh',
      args: ['-dedicated', '+map', 'de_dust2'],
    },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 30,
    ports: [
      { name: 'game', port: 27015, proto: 'udp' },
      { name: 'query', port: 27015, proto: 'udp' },
      { name: 'rcon', port: 27015, proto: 'tcp' },
      { name: 'sourcetv', port: 27020, proto: 'udp' },
    ],
    savePaths: ['game/csgo/cfg'],
    installedProbe: 'game/cs2.sh',
    settingsAdapter: 'source-cfg',
    // As TF2: the Steam login token goes on the command line. Without one
    // CS2 accepts connections only from LAN addresses.
    launchConfFile: 'rallypoint-launch.conf',
    capabilities: { query: 'a2s', players: 'rcon', mods: 'none', world: false },
    diskEstimateGb: 35,
    supportLevel: 'full',
  },
  enshrouded: {
    slug: 'enshrouded',
    name: 'Enshrouded',
    steamAppId: 2278520,
    // The dedicated server is Windows-only; installed via the Windows
    // depot and run under Wine (see unit-provision.ts).
    platform: 'windows',
    startCommand: { bin: './enshrouded_server.exe', args: [] },
    stopSignal: 'SIGINT',
    timeoutStopSec: 120,
    memoryHigh: '12G',
    memoryMax: '16G',
    ports: [
      { name: 'game', port: 15636, proto: 'udp' },
      // Clients discover and join over the query port — this is the one
      // to port-forward or tunnel, not the game port.
      { name: 'query', port: 15637, proto: 'udp', join: true },
    ],
    savePaths: ['savegame'],
    installedProbe: 'enshrouded_server.exe',
    settingsAdapter: 'enshrouded-json',
    // No admin API and no official mod system, but the Steam query port
    // answers A2S_INFO — read-only name/version/player counts.
    capabilities: { query: 'a2s', players: 'none', mods: 'none', world: true },
    // The server announces tick starvation as "server overloaded" and
    // reports save trouble separately; both are what a player actually
    // feels, so they lead the list ahead of the generic patterns.
    logPatterns: {
      error: ['server (is )?overload', 'overloaded', 'sav(e|ing).*(fail|error)', '\\berrors?\\b', '\\bwarn(ing)?\\b'],
    },
    diskEstimateGb: 8,
    supportLevel: 'full',
  },
  unturned: {
    slug: 'unturned',
    name: 'Unturned',
    steamAppId: 1110390,
    startCommand: { bin: './ServerHelper.sh', args: ['+InternetServer/rallypoint'] },
    stopSignal: 'SIGINT',
    timeoutStopSec: 60,
    ports: [
      // Unturned's configured `Port` is the Steam QUERY port and the one
      // players connect through; game traffic runs on Port + 1.
      { name: 'query', port: 27015, proto: 'udp', join: true },
      { name: 'game', port: 27016, proto: 'udp' },
    ],
    savePaths: ['Servers'],
    installedProbe: 'ServerHelper.sh',
    settingsAdapter: 'unturned-commands',
    // Vanilla Unturned exposes no remote admin protocol.
    capabilities: { query: 'a2s', players: 'none', mods: 'none', world: true },
    diskEstimateGb: 8,
    supportLevel: 'full',
  },
}

export const GAME_SLUGS = Object.keys(GAMES) as [string, ...string[]]

export function gameBySlug(slug: string): GameDef | undefined {
  return GAMES[slug]
}

// The UDP port players connect through — what a router forward or a
// playit tunnel must target. Usually the 'game' port; a port flagged
// join: true overrides it (Enshrouded joins over its query port).
export function joinPort(ports: { name: string; port: number; join?: boolean }[]): number | null {
  return (ports.find((p) => p.join) ?? ports.find((p) => p.name === 'game'))?.port ?? null
}

// Which player-admin actions a game's admin channel actually supports.
// Drives the Players page UI and per-endpoint API gating — a capability
// kind says how the panel talks to the game; this says what it can say.
export interface PlayerAdminFeatures {
  list: boolean
  kick: boolean
  ban: boolean
  unban: boolean
  announce: boolean
  save: boolean
}

// Per-slug deviations from "everything works". Source games (TF2/CS2)
// have no console command to force a save — there is no world to save.
const ADMIN_FEATURE_OVERRIDES: Record<string, Partial<PlayerAdminFeatures>> = {
  'team-fortress-2': { save: false },
  'counter-strike-2': { save: false },
}

// Which per-player fields a game's admin channel actually reports. This
// is a property of the protocol, not of who happens to be online: ARK's
// `listplayers` gives a name and an id and nothing else, whatever the
// server is doing. Driving the table columns from this keeps them stable
// instead of appearing and vanishing as players join.
export interface PlayerFields {
  level: boolean
  ping: boolean
}

const PLAYER_FIELDS: Record<string, PlayerFields> = {
  // Palworld's REST API and 7DTD's `lp` both report level and ping.
  'pal-rest': { level: true, ping: true },
  telnet: { level: true, ping: true },
  // Source `status` and Rust's `playerlist` report ping only.
  rcon: { level: false, ping: true },
  webrcon: { level: false, ping: true },
  none: { level: false, ping: false },
}

// ARK and Project Zomboid speak RCON but their list commands report
// neither field.
const PLAYER_FIELD_OVERRIDES: Record<string, PlayerFields> = {
  'ark-survival-evolved': { level: false, ping: false },
  'project-zomboid': { level: false, ping: false },
}

export function playerFields(game: GameDef): PlayerFields {
  return (
    PLAYER_FIELD_OVERRIDES[game.slug] ?? PLAYER_FIELDS[game.capabilities.players] ?? { level: false, ping: false }
  )
}

export function playerAdminFeatures(game: GameDef): PlayerAdminFeatures {
  if (game.capabilities.players === 'none') {
    return { list: false, kick: false, ban: false, unban: false, announce: false, save: false }
  }
  return {
    list: true,
    kick: true,
    ban: true,
    unban: true,
    announce: true,
    save: true,
    ...ADMIN_FEATURE_OVERRIDES[game.slug],
  }
}

export function appManifestFor(steamAppId: number): string {
  return `steamapps/appmanifest_${steamAppId}.acf`
}

// The systemd template-unit instance a game's server runs under. Every
// game (Palworld included) uses this scheme.
export function templateUnitFor(slug: string): string {
  return `rallypoint-game@${slug}.service`
}
