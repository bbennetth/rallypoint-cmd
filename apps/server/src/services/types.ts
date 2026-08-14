import type { GameDef, LongOpKind, PalServerInfo, PalServerMetrics, Player } from '@rallypoint-cmd/shared'
import type { WorldLock } from './world-lock.js'
import type { LongOpRunner } from './long-op.js'
import type { SettingsService } from './settings-ini.js'
import type { BackupService } from './backup.js'
import type { ModsService } from './mods.js'
import type { SchedulerService } from './scheduler.js'
import type { PanelUpdateService } from './panel-update.js'
import type { PublicAccessService } from './public-access.js'

// Every game-facing integration is an interface with a real (LXC) and a
// fake (laptop/e2e) implementation, chosen by PANEL_MODE in compose.ts.
// One set of instance services exists per managed server row; panel
// services (scheduler, self-update, public access) are singletons.

export interface SystemdStatus {
  // Install probe (e.g. PalServer.sh) present on disk — false renders as
  // `not_installed`.
  installed: boolean
  activeState: string // active | inactive | activating | deactivating | failed
  subState: string
  memoryCurrentBytes: number | null
  activeEnterAtMs: number | null
}

export interface GameControl {
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  status(): Promise<SystemdStatus>
  // Poll until the unit reaches the state (or timeout). Resolves true on
  // success, false on timeout.
  waitFor(state: 'active' | 'inactive', timeoutMs: number): Promise<boolean>
}

// Admin/query channel into the running game. Palworld's REST API is the
// rich implementation; games without an admin API get a stub whose
// reachable() is always false and whose other methods throw (routes are
// capability-gated before they get here).
export interface GameQuery {
  reachable(): Promise<boolean>
  info(): Promise<PalServerInfo>
  players(): Promise<Player[]>
  metrics(): Promise<PalServerMetrics>
  announce(message: string): Promise<void>
  kick(userId: string, message?: string): Promise<void>
  ban(userId: string, message?: string): Promise<void>
  unban(userId: string): Promise<void>
  save(): Promise<void>
}

// Per-instance journald tailer. SSE handlers subscribe — they never spawn.
export interface Journal {
  buffer(): readonly string[]
  subscribe(cb: (line: string) => void): () => void
  start(): void
  stop(): void
}

// Sink long-running ops write into; the runner fans lines/progress out
// to SSE subscribers.
export interface OpSink {
  line(text: string): void
  progress(pct: number): void
}

export interface SteamCmd {
  run(kind: Extract<LongOpKind, 'install' | 'update' | 'validate'>, sink: OpSink): Promise<void>
  installedBuildId(): Promise<string | null>
}

// One managed game-server instance: the DB row's identity plus its own
// set of service implementations and coordination primitives.
export interface ServerInstance {
  id: string
  name: string
  installDir: string
  unitName: string
  game: GameDef
  gameControl: GameControl
  query: GameQuery
  journal: Journal
  steamcmd: SteamCmd
  settings: SettingsService
  backup: BackupService
  mods: ModsService
  longOps: LongOpRunner
  worldLock: WorldLock
  dispose(): void
}

// Request-scoped service bag: the resolved instance's services flattened
// together with the panel singletons, so handlers keep one access
// pattern (`c.get('services').gameControl` …).
export interface Services {
  instance: ServerInstance
  gameControl: GameControl
  query: GameQuery
  journal: Journal
  steamcmd: SteamCmd
  longOps: LongOpRunner
  worldLock: WorldLock
  settings: SettingsService
  backup: BackupService
  mods: ModsService
  scheduler: SchedulerService
  panelUpdate: PanelUpdateService
  publicAccess: PublicAccessService
}
