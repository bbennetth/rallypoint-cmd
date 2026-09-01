import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  DEFAULT_ERROR_PATTERNS,
  compileErrorMatcher,
  effectiveResources,
  parseSystemdBytes,
  type GameDef,
  type MetricsErrorLine,
  type MetricsSample,
  type MetricsSnapshot,
  type ResourceOverrides,
  type PalServerInfo,
  type PalServerMetrics,
  type Player,
} from '@rallypoint-cmd/shared'
import type { Env } from '../../env.js'
import type { Logger } from '../../logger.js'
import type { GameControl, GameQuery, Journal, MetricsSampler, OpSink, PlayerAdmin, SteamCmd, SystemdStatus } from '../types.js'
import { createNullAdmin, createNullQuery } from '../stubs.js'
import { SEED_LAYOUTS } from './seed-layouts.js'

// Fake implementations of every game-facing service, driven by one
// in-memory world per server instance. Lets the entire panel run (and be
// Playwright-tested) on a laptop: the game "boots", players show up,
// steamcmd streams progress, the journal ticks — all against a temp-dir
// sandbox under ./data.

const FAKE_WORLD_ID = '0123456789ABCDEF0123456789ABCDEF'
const FAKE_BUILD_ID = '20260719'

const DEFAULT_INI = `[/Script/Pal.PalGameWorldSettings]
OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,NightTimeSpeedRate=1.000000,ExpRate=1.000000,PalCaptureRate=1.000000,PalSpawnNumRate=1.000000,PalDamageRateAttack=1.000000,PalDamageRateDefense=1.000000,PlayerDamageRateAttack=1.000000,PlayerDamageRateDefense=1.000000,PlayerStomachDecreaceRate=1.000000,PlayerStaminaDecreaceRate=1.000000,PlayerAutoHPRegeneRate=1.000000,PlayerAutoHpRegeneRateInSleep=1.000000,PalStomachDecreaceRate=1.000000,PalStaminaDecreaceRate=1.000000,PalAutoHPRegeneRate=1.000000,PalAutoHpRegeneRateInSleep=1.000000,BuildObjectDamageRate=1.000000,BuildObjectDeteriorationDamageRate=1.000000,CollectionDropRate=1.000000,CollectionObjectHpRate=1.000000,CollectionObjectRespawnSpeedRate=1.000000,EnemyDropItemRate=1.000000,ItemWeightRate=1.000000,BuildObjectHpRate=1.000000,AutoSaveSpan=30.000000,bHardcore=False,bPalLost=False,bCharacterRecreateInHardcore=False,bInvisibleOtherGuildBaseCampAreaFX=False,bBuildAreaLimit=False,ChatPostLimitPerMinute=30,BaseCampMaxNumInGuild=8,RandomizerType=None,RandomizerSeed="",bIsRandomizerPalLevelRandom=False,DeathPenalty=All,bEnablePlayerToPlayerDamage=False,bEnableFriendlyFire=False,bEnableInvaderEnemy=True,bActiveUNKO=False,bEnableAimAssistPad=True,bEnableAimAssistKeyboard=False,DropItemMaxNum=3000,DropItemMaxNum_UNKO=100,BaseCampMaxNum=128,BaseCampWorkerMaxNum=15,DropItemAliveMaxHours=1.000000,bAutoResetGuildNoOnlinePlayers=False,AutoResetGuildTimeNoOnlinePlayers=72.000000,GuildPlayerMaxNum=20,PalEggDefaultHatchingTime=72.000000,WorkSpeedRate=1.000000,bIsMultiplay=False,bIsPvP=False,bCanPickupOtherGuildDeathPenaltyDrop=False,bEnableNonLoginPenalty=True,bEnableFastTravel=True,bIsStartLocationSelectByMap=False,bExistPlayerAfterLogout=False,bEnableDefenseOtherGuildPlayer=False,CoopPlayerMaxNum=4,ServerPlayerMaxNum=32,ServerName="Fake Palworld Server",ServerDescription="Mock-mode sandbox",AdminPassword="mock-admin-password",ServerPassword="",PublicPort=8211,PublicIP="",RCONEnabled=False,RCONPort=25575,Region="",bUseAuth=True,BanListURL="https://api.palworldgame.com/api/banlist.txt",RESTAPIEnabled=True,RESTAPIPort=8212,bShowPlayerList=False,AllowConnectPlatform=Steam,bIsUseBackupSaveData=True,LogFormatType=Text,SupplyDropSpan=180)
`

const GAME_USER_SETTINGS = `[/Script/Pal.PalGameLocalSettings]
AudioSettings=(Master=1.000000)
DedicatedServerName=${FAKE_WORLD_ID.toLowerCase()}
`

const DEFAULT_ENSHROUDED_JSON = {
  name: 'Fake Enshrouded Server',
  password: '',
  saveDirectory: './savegame',
  logDirectory: './logs',
  ip: '0.0.0.0',
  queryPort: 15637,
  slotCount: 16,
  gameSettingsPreset: 'Default',
  enableVoiceChat: false,
  enableTextChat: false,
  gameSettings: {
    playerHealthFactor: 1,
    playerManaFactor: 1,
    playerStaminaFactor: 1,
    enableDurability: true,
    tombstoneMode: 'AddBackpackMaterials',
    enemyDamageFactor: 1,
    enemyHealthFactor: 1,
    randomSpawnerAmount: 'Normal',
    aggroPoolAmount: 'Normal',
    weatherFrequency: 'Normal',
    dayTimeDuration: 1_800_000_000_000,
    nightTimeDuration: 720_000_000_000,
  },
  userGroups: [
    { name: 'Admin', password: 'AdminXXXXXXXX', canKickBan: true },
    { name: 'Friend', password: 'FriendXXXXXXXX', canKickBan: false },
    { name: 'Guest', password: 'GuestXXXXXXXX', canKickBan: false },
  ],
}

type FakeGameState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed'

class FakeWorld {
  state: FakeGameState = 'inactive'
  installed = false
  buildId: string | null = null
  activeEnterAtMs: number | null = null
  private emitter = new EventEmitter()
  private journalLines: string[] = []
  private tick: ReturnType<typeof setInterval> | null = null
  private installDir: string
  private game: GameDef

  constructor(installDir: string, game: GameDef) {
    this.installDir = installDir
    this.game = game
    this.emitter.setMaxListeners(100)
    this.installed = fs.existsSync(path.join(installDir, game.installedProbe))
    if (this.installed) this.buildId = FAKE_BUILD_ID
  }

  // --- sandbox filesystem -------------------------------------------------

  install(): void {
    const root = this.installDir
    // Every game gets its install probe + a fake app manifest; Palworld
    // additionally gets the config/save layout its full-support services
    // (settings ini, world resolve, backups, mods) expect.
    const probePath = path.join(root, this.game.installedProbe)
    fs.mkdirSync(path.dirname(probePath), { recursive: true })
    fs.writeFileSync(probePath, '#!/bin/sh\necho fake\n')
    fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'steamapps', `appmanifest_${this.game.steamAppId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${this.game.steamAppId}"\n\t"buildid"\t\t"${FAKE_BUILD_ID}"\n}\n`,
    )
    if (this.game.slug === 'palworld') {
      const cfgDir = path.join(root, 'Pal/Saved/Config/LinuxServer')
      const saveDir = path.join(root, 'Pal/Saved/SaveGames/0', FAKE_WORLD_ID)
      fs.mkdirSync(cfgDir, { recursive: true })
      fs.mkdirSync(saveDir, { recursive: true })
      fs.writeFileSync(path.join(root, 'DefaultPalWorldSettings.ini'), DEFAULT_INI)
      const ini = path.join(cfgDir, 'PalWorldSettings.ini')
      if (!fs.existsSync(ini)) fs.writeFileSync(ini, DEFAULT_INI)
      const gus = path.join(cfgDir, 'GameUserSettings.ini')
      if (!fs.existsSync(gus)) fs.writeFileSync(gus, GAME_USER_SETTINGS)
      const level = path.join(saveDir, 'Level.sav')
      if (!fs.existsSync(level)) fs.writeFileSync(level, Buffer.from('fake-level-data'))
      fs.writeFileSync(path.join(saveDir, 'LevelMeta.sav'), Buffer.from('fake-level-meta'))
      fs.mkdirSync(path.join(saveDir, 'Players'), { recursive: true })
      fs.writeFileSync(path.join(saveDir, 'Players', 'fake-player.sav'), Buffer.from('fake-player'))
    } else if (this.game.slug === 'enshrouded') {
      // Config + save layout the full-support services (JSON settings,
      // world-id-free backups) expect.
      const cfg = path.join(root, 'enshrouded_server.json')
      if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, `${JSON.stringify(DEFAULT_ENSHROUDED_JSON, null, 4)}\n`)
      const saveDir = path.join(root, 'savegame')
      fs.mkdirSync(saveDir, { recursive: true })
      if (!fs.existsSync(path.join(saveDir, '3ad85aea'))) {
        fs.writeFileSync(path.join(saveDir, '3ad85aea'), Buffer.from('fake-enshrouded-world'))
        fs.writeFileSync(path.join(saveDir, '3ad85aea-index'), Buffer.from('fake-enshrouded-index'))
      }
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
    } else {
      for (const savePath of this.game.savePaths) {
        fs.mkdirSync(path.join(root, savePath), { recursive: true })
      }
      // Config the game itself ships plus a save tree the game's backup
      // contract recognizes (see fake/seed-layouts.ts).
      for (const file of SEED_LAYOUTS[this.game.slug] ?? []) {
        const target = path.join(root, file.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (!fs.existsSync(target)) fs.writeFileSync(target, file.content)
      }
    }
    this.installed = true
    this.buildId = FAKE_BUILD_ID
  }

  // --- journal ------------------------------------------------------------

  log(line: string): void {
    this.journalLines.push(line)
    if (this.journalLines.length > 500) this.journalLines.shift()
    this.emitter.emit('line', line)
  }

  journalBuffer(): readonly string[] {
    return this.journalLines
  }

  onLine(cb: (line: string) => void): () => void {
    this.emitter.on('line', cb)
    return () => this.emitter.off('line', cb)
  }

  // --- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.state === 'active' || this.state === 'activating') return
    const unit = this.unitLabel()
    if (!this.installed) {
      this.state = 'failed'
      this.log(`[systemd] ${unit}: Failed — ${this.game.installedProbe} not found`)
      return
    }
    this.state = 'activating'
    this.log(`[systemd] Starting ${unit}...`)
    await sleep(1200)
    this.state = 'active'
    this.activeEnterAtMs = Date.now()
    if (this.game.slug === 'palworld') {
      this.log('[PalServer] Rcon disabled, REST API listening on 127.0.0.1:8212')
      this.log('[PalServer] World loaded: ' + FAKE_WORLD_ID)
    } else {
      this.log(`[${this.game.name}] Server started on port ${this.game.ports[0]?.port ?? 0}`)
    }
    this.tick = setInterval(() => {
      if (this.state === 'active') this.log(`[${this.game.name}] tick players=2 fps=59.8`)
    }, 5000)
  }

  async stop(): Promise<void> {
    if (this.state === 'inactive') return
    const unit = this.unitLabel()
    this.state = 'deactivating'
    this.log(`[systemd] Stopping ${unit}...`)
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    await sleep(800)
    this.state = 'inactive'
    this.activeEnterAtMs = null
    this.log(`[systemd] ${unit}: Deactivated successfully.`)
  }

  private unitLabel(): string {
    return `rallypoint-game@${this.game.slug}.service`
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
  }
}

// Collapse the simulated latencies under test so the suite isn't slow;
// dev/mock keeps the lifelike delays so the UI feels real.
const FAKE_SPEED = process.env.NODE_ENV === 'test' ? 0 : 1
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms * FAKE_SPEED))
}

const FAKE_PLAYERS: Player[] = [
  {
    name: 'ByronTest',
    playerId: 'PID_001',
    userId: 'steam_76561198000000001',
    ip: '10.0.0.42',
    ping: 23,
    level: 42,
    location_x: 1234.5,
    location_y: -567.8,
  },
  {
    name: 'PalFan99',
    playerId: 'PID_002',
    userId: 'steam_76561198000000002',
    ip: '10.0.0.77',
    ping: 41,
    level: 17,
    location_x: -900.1,
    location_y: 3300.0,
  },
]

export interface FakeInstanceServices {
  gameControl: GameControl
  query: GameQuery
  admin: PlayerAdmin
  journal: Journal
  metrics: MetricsSampler
  steamcmd: SteamCmd
  dispose(): void
}

// Simulated resource telemetry. The shape matters more than the numbers:
// a load that wanders, a periodic spike, and an overload line logged at
// the same instant as the spike — so the Monitoring page's central claim
// (pressure and errors line up) is visible and e2e-assertable without a
// real game.
const FAKE_TICK_MS = 2_000
const FAKE_HISTORY_MAX = 1_440
// Every Nth sample is a spike. Fixed rather than random so the e2e spec
// can rely on an overload line existing after backfill.
const SPIKE_EVERY = 8
const FAKE_OVERLOAD_LINE = 'Server overloaded — simulation tick took 812ms (budget 33ms)'

function createFakeMetricsSampler(
  world: FakeWorld,
  game: GameDef,
  getOverrides?: () => ResourceOverrides,
): MetricsSampler {
  const history: MetricsSample[] = []
  const errors: MetricsErrorLine[] = []
  const matcher = compileErrorMatcher(game.logPatterns?.error ?? DEFAULT_ERROR_PATTERNS)
  const memHighBytes = parseSystemdBytes(game.memoryHigh)
  const hostCpus = Math.max(1, os.cpus().length)
  const hostMemBytes = os.totalmem()
  function currentLimits() {
    const effective = effectiveResources(game, getOverrides?.())
    return {
      memHighBytes: parseSystemdBytes(effective.memoryHigh ?? undefined),
      memMaxBytes: parseSystemdBytes(effective.memoryMax ?? undefined),
      cpuQuotaPct: effective.cpuQuotaPct,
      hostCpus,
      hostMemBytes,
    }
  }
  // Wander around a plausible idle load for a mid-size server.
  const memBase = memHighBytes !== null ? memHighBytes * 0.62 : 6 * 1024 ** 3
  let cpu = 34
  let mem = memBase
  let latency = 28
  let n = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let backfilled = false

  function recordError(line: string, ts: number): void {
    if (!matcher?.test(line)) return
    errors.push({ ts, line })
    if (errors.length > 100) errors.shift()
  }

  const drift = (v: number, by: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * by))

  // One simulated sample. `at` lets backfill lay down a past series with
  // the same generator the live tick uses.
  function step(at: number, quiet = false): MetricsSample {
    n += 1
    const spike = n % SPIKE_EVERY === 0
    cpu = spike ? drift(93, 8, 80, 100) : drift(cpu, 14, 12, 62)
    mem = drift(mem, memBase * 0.05, memBase * 0.7, memBase * 1.18)
    latency = spike ? drift(220, 90, 120, 400) : drift(latency, 18, 8, 70)
    if (spike && !quiet) world.log(`[${game.name}] ${FAKE_OVERLOAD_LINE}`)
    else if (spike) recordError(FAKE_OVERLOAD_LINE, at)
    return {
      ts: at,
      cpuPct: Math.round(cpu * 10) / 10,
      cpuThrottledPct: spike ? Math.round(drift(18, 10, 4, 40) * 10) / 10 : 0,
      cpuPressure: Math.round((spike ? drift(55, 20, 30, 90) : drift(4, 6, 0, 18)) * 10) / 10,
      memPressure: Math.round(drift(1, 2, 0, 6) * 10) / 10,
      memBytes: Math.round(mem),
      latencyMs: Math.round(latency),
      reachable: true,
      load1: Math.round(((cpu / 100) * hostCpus + Math.random() * 0.4) * 100) / 100,
    }
  }

  function push(sample: MetricsSample): void {
    history.push(sample)
    if (history.length > FAKE_HISTORY_MAX) history.shift()
  }

  // Lay down a past window the first time the server comes up, so the
  // charts have a shape to draw immediately instead of one lonely point.
  function backfill(): void {
    if (backfilled) return
    backfilled = true
    const now = Date.now()
    for (let i = 120; i > 0; i -= 1) push(step(now - i * FAKE_TICK_MS, true))
  }

  return {
    snapshot: (): MetricsSnapshot => {
      const running = world.state === 'active'
      if (running) backfill()
      const cutoff = Date.now() - 3_600_000
      return {
        running,
        limits: currentLimits(),
        current: running && history.length > 0 ? history[history.length - 1]! : null,
        history: [...history],
        errors: {
          recent: [...errors],
          lastHourCount: errors.reduce((c, e) => (e.ts >= cutoff ? c + 1 : c), 0),
        },
      }
    },
    start: () => {
      if (timer) return
      for (const line of world.journalBuffer()) recordError(line, Date.now())
      unsubscribe = world.onLine((line) => recordError(line, Date.now()))
      timer = setInterval(() => {
        if (world.state !== 'active') return
        backfill()
        push(step(Date.now()))
      }, FAKE_TICK_MS)
      timer.unref()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

export function createFakeInstanceServices(
  _env: Env,
  logger: Logger,
  installDir: string,
  game: GameDef,
  getResourceOverrides?: () => ResourceOverrides,
): FakeInstanceServices {
  const world = new FakeWorld(installDir, game)
  const banned = new Set<string>()

  const gameControl: GameControl = {
    start: () => world.start(),
    stop: () => world.stop(),
    restart: async () => {
      await world.stop()
      await world.start()
    },
    status: (): Promise<SystemdStatus> =>
      Promise.resolve({
        installed: world.installed,
        activeState: world.state,
        subState: world.state === 'active' ? 'running' : 'dead',
        memoryCurrentBytes: world.state === 'active' ? 9_500_000_000 : null,
        activeEnterAtMs: world.activeEnterAtMs,
      }),
    waitFor: async (state, timeoutMs) => {
      const want: FakeGameState = state === 'active' ? 'active' : 'inactive'
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (world.state === want) return true
        await sleep(100)
      }
      return world.state === want
    },
  }

  const requireUp = (): void => {
    if (world.state !== 'active') throw new Error(`${game.name} admin API is unreachable (game down)`)
  }

  const palQuery: GameQuery & PlayerAdmin = {
    reachable: () => Promise.resolve(world.state === 'active'),
    info: (): Promise<PalServerInfo> => {
      requireUp()
      return Promise.resolve({
        version: 'v0.6.1',
        servername: 'Fake Palworld Server',
        description: 'Mock-mode sandbox',
        worldguid: FAKE_WORLD_ID,
      })
    },
    players: () => {
      requireUp()
      return Promise.resolve(FAKE_PLAYERS.filter((p) => !banned.has(p.userId)))
    },
    metrics: (): Promise<PalServerMetrics> => {
      requireUp()
      const uptime = world.activeEnterAtMs ? Math.floor((Date.now() - world.activeEnterAtMs) / 1000) : 0
      return Promise.resolve({
        serverfps: 60,
        currentplayernum: FAKE_PLAYERS.filter((p) => !banned.has(p.userId)).length,
        serverframetime: 16.6,
        maxplayernum: 32,
        uptime,
        days: 12,
      })
    },
    announce: (message) => {
      requireUp()
      world.log(`[Announce] ${message}`)
      return Promise.resolve()
    },
    kick: (userId, message) => {
      requireUp()
      world.log(`[Admin] Kicked ${userId}${message ? ` (${message})` : ''}`)
      return Promise.resolve()
    },
    ban: (userId, message) => {
      requireUp()
      banned.add(userId)
      world.log(`[Admin] Banned ${userId}${message ? ` (${message})` : ''}`)
      return Promise.resolve()
    },
    unban: (userId) => {
      banned.delete(userId)
      world.log(`[Admin] Unbanned ${userId}`)
      return Promise.resolve()
    },
    save: () => {
      requireUp()
      world.log('[PalServer] World saved.')
      return Promise.resolve()
    },
  }

  // Read-only query stand-in for the games whose real adapter is A2S or
  // Satisfactory's lightweight query. Deliberately sparser than the
  // Palworld fixture: those protocols carry no fps or uptime, and
  // Satisfactory carries no player counts either, so mock mode exercises
  // the same missing-field rendering the real thing produces.
  const readOnlyQuery: GameQuery = {
    reachable: () => Promise.resolve(world.state === 'active'),
    info: (): Promise<PalServerInfo> => {
      requireUp()
      return Promise.resolve({ servername: `Fake ${game.name} Server`, version: 'v1.0-fake' })
    },
    metrics: (): Promise<PalServerMetrics> => {
      requireUp()
      if (game.capabilities.query === 'satisfactory-lwq') return Promise.resolve({})
      return Promise.resolve({
        currentplayernum: FAKE_PLAYERS.filter((p) => !banned.has(p.userId)).length,
        maxplayernum: 16,
      })
    },
  }

  // Admin stand-in for the protocol-based channels. RCON and telnet
  // report far less about a player than Palworld's REST API — no
  // location, and only 7DTD reports a level — so the fixture is trimmed
  // to what each protocol can actually answer.
  const protocolAdmin: PlayerAdmin = {
    players: () => {
      requireUp()
      const kind = game.capabilities.players
      return Promise.resolve(
        FAKE_PLAYERS.filter((p) => !banned.has(p.userId)).map((p) => ({
          name: p.name,
          playerId: p.playerId,
          userId: p.userId,
          ...(p.ping !== undefined ? { ping: p.ping } : {}),
          ...(kind === 'telnet' && p.level !== undefined ? { level: p.level } : {}),
        })),
      )
    },
    announce: (message) => {
      requireUp()
      world.log(`[Admin] say ${message}`)
      return Promise.resolve()
    },
    kick: (userId, message) => {
      requireUp()
      world.log(`[Admin] Kicked ${userId}${message ? ` (${message})` : ''}`)
      return Promise.resolve()
    },
    ban: (userId, message) => {
      requireUp()
      banned.add(userId)
      world.log(`[Admin] Banned ${userId}${message ? ` (${message})` : ''}`)
      return Promise.resolve()
    },
    unban: (userId) => {
      banned.delete(userId)
      world.log(`[Admin] Unbanned ${userId}`)
      return Promise.resolve()
    },
    save: () => {
      requireUp()
      world.log('[Admin] World saved.')
      return Promise.resolve()
    },
  }

  const journal: Journal = {
    buffer: () => world.journalBuffer(),
    subscribe: (cb) => world.onLine(cb),
    start: () => {},
    stop: () => {},
  }

  const steamcmd: SteamCmd = {
    run: async (kind, sink: OpSink) => {
      sink.line(`steamcmd +login anonymous +app_update ${game.steamAppId} validate (${kind})`)
      sink.line('Steam Console Client (c) Valve Corporation - version 1734112433')
      for (let pct = 0; pct <= 100; pct += 10) {
        sink.progress(pct)
        sink.line(` Update state (0x61) downloading, progress: ${pct.toFixed(2)} (${pct} of 100)`)
        await sleep(400)
      }
      world.install()
      sink.line(`Success! App '${game.steamAppId}' fully installed.`)
      logger.info('fake steamcmd finished', { kind, game: game.slug })
    },
    installedBuildId: () => Promise.resolve(world.buildId),
  }

  const metrics = createFakeMetricsSampler(world, game, getResourceOverrides)
  metrics.start()

  return {
    gameControl,
    query:
      game.capabilities.query === 'pal-rest'
        ? palQuery
        : game.capabilities.query === 'none'
          ? createNullQuery(game)
          : readOnlyQuery,
    admin:
      game.capabilities.players === 'pal-rest'
        ? palQuery
        : game.capabilities.players === 'none'
          ? createNullAdmin(game)
          : protocolAdmin,
    journal,
    metrics,
    steamcmd,
    dispose: () => {
      metrics.stop()
      world.dispose()
    },
  }
}
