import type { GameDef, LongOpKind, MetricsSnapshot, PalServerInfo, PalServerMetrics, Player, ResourceOverrides } from '@rallypoint-cmd/shared'
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

// Read-only status channel into the running game (name/version/player
// counts). Palworld's REST API is the rich implementation; A2S is the
// generic Steam-query fallback. Games without any query API get a stub
// whose reachable() is always false and whose other methods throw
// (routes are capability-gated before they get here).
export interface GameQuery {
  reachable(): Promise<boolean>
  info(): Promise<PalServerInfo>
  metrics(): Promise<PalServerMetrics>
}

// Admin channel into the running game — player list and moderation,
// broadcast, force-save. Selected by capabilities.players: Palworld's
// REST API implements this alongside GameQuery; RCON/webrcon/telnet
// clients implement only this. Which actions actually work per game is
// described by playerAdminFeatures() in the shared registry.
export interface PlayerAdmin {
  players(): Promise<Player[]>
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

// Per-instance resource sampler. It polls on its own timer and answers
// from memory, so the route handler never blocks on a probe — and a slow
// or unreachable game degrades one sample, not the request.
// Named for the sampling, not `Metrics`, to stay distinct from
// GameQuery.metrics() (player counts from the game's own API).
export interface MetricsSampler {
  snapshot(): MetricsSnapshot
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
  admin: PlayerAdmin
  journal: Journal
  metrics: MetricsSampler
  steamcmd: SteamCmd
  settings: SettingsService
  backup: BackupService
  mods: ModsService
  longOps: LongOpRunner
  worldLock: WorldLock
  // Per-server resource overrides (memory/CPU limits over the registry
  // defaults). Held in-memory alongside the DB row so the metrics
  // sampler reflects a save without a panel restart.
  getResourceOverrides(): ResourceOverrides
  setResourceOverrides(overrides: ResourceOverrides): void
  dispose(): void
}

// Request-scoped service bag: the resolved instance's services flattened
// together with the panel singletons, so handlers keep one access
// pattern (`c.get('services').gameControl` …).
export interface Services {
  instance: ServerInstance
  gameControl: GameControl
  query: GameQuery
  admin: PlayerAdmin
  journal: Journal
  metrics: MetricsSampler
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
