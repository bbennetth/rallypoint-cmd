// Data-driven game registry. Every game the panel can manage is an entry
// here; server-side services and the web UI both derive behavior from the
// entry rather than hardcoding any one game. Adding a game is a data
// change (plus deploy files: systemd drop-in + sudoers lines, generated
// from this registry and drift-tested).
//
// Invariant: every entry is installable with `steamcmd +login anonymous`
// (no Steam account) and is either a native Linux dedicated server or a
// Windows-only one run under Wine (`platform: 'windows'`).

export type SettingsAdapterKind = 'palworld-ini' | 'enshrouded-json' | 'none'
export type QueryKind = 'pal-rest' | 'a2s' | 'none'
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
  capabilities: {
    query: QueryKind
    players: boolean
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
  // 'full' = settings/players/mods/backups wired; 'basic' = install,
  // start/stop, console, updates and restart schedules only.
  supportLevel: 'full' | 'basic'
}

const BASIC_CAPS = { query: 'none', players: false, mods: 'none', world: false } as const

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
    capabilities: { query: 'pal-rest', players: true, mods: 'ue-paks', world: true },
    diskEstimateGb: 12,
    supportLevel: 'full',
  },
  valheim: {
    slug: 'valheim',
    name: 'Valheim',
    steamAppId: 896660,
    startCommand: {
      bin: './valheim_server.x86_64',
      args: ['-nographics', '-batchmode', '-name', 'Rallypoint', '-port', '2456', '-world', 'Dedicated', '-public', '0'],
    },
    stopSignal: 'SIGINT',
    timeoutStopSec: 60,
    memoryHigh: '4G',
    memoryMax: '6G',
    ports: [{ name: 'game', port: 2456, proto: 'udp' }],
    savePaths: ['.config/unity3d/IronGate/Valheim/worlds_local'],
    installedProbe: 'valheim_server.x86_64',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 2,
    supportLevel: 'basic',
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
      { name: 'rcon', port: 28016, proto: 'tcp' },
    ],
    savePaths: ['server/rallypoint'],
    installedProbe: 'RustDedicated',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 35,
    supportLevel: 'basic',
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
      { name: 'query', port: 27015, proto: 'udp' },
    ],
    savePaths: ['ShooterGame/Saved'],
    installedProbe: 'ShooterGame/Binaries/Linux/ShooterGameServer',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 100,
    supportLevel: 'basic',
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
    ports: [{ name: 'game', port: 26900, proto: 'udp' }],
    savePaths: ['.local/share/7DaysToDie/Saves'],
    installedProbe: '7DaysToDieServer.x86_64',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 15,
    supportLevel: 'basic',
  },
  'project-zomboid': {
    slug: 'project-zomboid',
    name: 'Project Zomboid',
    steamAppId: 380870,
    startCommand: { bin: './start-server.sh', args: ['-servername', 'rallypoint'] },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 120,
    ports: [{ name: 'game', port: 16261, proto: 'udp' }],
    savePaths: ['Zomboid/Saves'],
    installedProbe: 'start-server.sh',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 5,
    supportLevel: 'basic',
  },
  satisfactory: {
    slug: 'satisfactory',
    name: 'Satisfactory',
    steamAppId: 1690800,
    startCommand: { bin: './FactoryServer.sh', args: [] },
    stopSignal: 'SIGINT',
    timeoutStopSec: 90,
    ports: [{ name: 'game', port: 7777, proto: 'udp' }],
    savePaths: ['FactoryGame/Saved/SaveGames'],
    installedProbe: 'FactoryServer.sh',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 15,
    supportLevel: 'basic',
  },
  'team-fortress-2': {
    slug: 'team-fortress-2',
    name: 'Team Fortress 2',
    steamAppId: 232250,
    startCommand: { bin: './srcds_run', args: ['-game', 'tf', '+map', 'cp_dustbowl', '+maxplayers', '24'] },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 30,
    ports: [{ name: 'game', port: 27015, proto: 'udp' }],
    savePaths: ['tf/cfg'],
    installedProbe: 'srcds_run',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 25,
    supportLevel: 'basic',
  },
  'counter-strike-2': {
    slug: 'counter-strike-2',
    name: 'Counter-Strike 2',
    steamAppId: 730,
    startCommand: {
      bin: './game/bin/linuxsteamrt64/cs2',
      args: ['-dedicated', '+map', 'de_dust2'],
    },
    stopSignal: 'SIGTERM',
    timeoutStopSec: 30,
    ports: [{ name: 'game', port: 27015, proto: 'udp' }],
    savePaths: ['game/csgo/cfg'],
    installedProbe: 'game/bin/linuxsteamrt64/cs2',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 35,
    supportLevel: 'basic',
  },
  enshrouded: {
    slug: 'enshrouded',
    name: 'Enshrouded',
    steamAppId: 2278520,
    // The dedicated server is Windows-only; installed via the Windows
    // depot and run under Wine (see rallypoint-cmd-game).
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
    capabilities: { query: 'a2s', players: false, mods: 'none', world: true },
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
    ports: [{ name: 'game', port: 27015, proto: 'udp' }],
    savePaths: ['Servers'],
    installedProbe: 'ServerHelper.sh',
    settingsAdapter: 'none',
    capabilities: BASIC_CAPS,
    diskEstimateGb: 8,
    supportLevel: 'basic',
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

export function appManifestFor(steamAppId: number): string {
  return `steamapps/appmanifest_${steamAppId}.acf`
}

// The systemd template-unit instance a game's server runs under. Every
// game (Palworld included) uses this scheme.
export function templateUnitFor(slug: string): string {
  return `rallypoint-game@${slug}.service`
}
