import type { LongOpKind, PalServerInfo, PalServerMetrics, Player } from '@rallypoint-cmd/shared'
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

export interface SystemdStatus {
  // PalServer.sh present on disk — false renders as `not_installed`.
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

export interface PalRest {
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

// Singleton journald tailer. SSE handlers subscribe — they never spawn.
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

export interface Services {
  gameControl: GameControl
  palRest: PalRest
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
