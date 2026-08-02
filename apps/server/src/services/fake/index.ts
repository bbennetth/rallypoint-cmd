import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { PalServerInfo, PalServerMetrics, Player } from '@rallypoint-cmd/shared'
import type { Env } from '../../env.js'
import type { Logger } from '../../logger.js'
import type { GameControl, Journal, OpSink, PalRest, SteamCmd, SystemdStatus } from '../types.js'

// Fake implementations of every game-facing service, driven by one
// shared in-memory world. Lets the entire panel run (and be
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

type FakeGameState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed'

class FakeWorld {
  state: FakeGameState = 'inactive'
  installed = false
  buildId: string | null = null
  activeEnterAtMs: number | null = null
  private emitter = new EventEmitter()
  private journalLines: string[] = []
  private tick: ReturnType<typeof setInterval> | null = null
  private env: Env

  constructor(env: Env) {
    this.env = env
    this.emitter.setMaxListeners(100)
    this.installed = fs.existsSync(path.join(env.PAL_DIR, 'PalServer.sh'))
    if (this.installed) this.buildId = FAKE_BUILD_ID
  }

  // --- sandbox filesystem -------------------------------------------------

  install(): void {
    const pal = this.env.PAL_DIR
    const cfgDir = path.join(pal, 'Pal/Saved/Config/LinuxServer')
    const saveDir = path.join(pal, 'Pal/Saved/SaveGames/0', FAKE_WORLD_ID)
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(saveDir, { recursive: true })
    fs.mkdirSync(path.join(pal, 'steamapps'), { recursive: true })
    fs.writeFileSync(path.join(pal, 'PalServer.sh'), '#!/bin/sh\necho fake\n')
    fs.writeFileSync(path.join(pal, 'DefaultPalWorldSettings.ini'), DEFAULT_INI)
    const ini = path.join(cfgDir, 'PalWorldSettings.ini')
    if (!fs.existsSync(ini)) fs.writeFileSync(ini, DEFAULT_INI)
    const gus = path.join(cfgDir, 'GameUserSettings.ini')
    if (!fs.existsSync(gus)) fs.writeFileSync(gus, GAME_USER_SETTINGS)
    const level = path.join(saveDir, 'Level.sav')
    if (!fs.existsSync(level)) fs.writeFileSync(level, Buffer.from('fake-level-data'))
    fs.writeFileSync(path.join(saveDir, 'LevelMeta.sav'), Buffer.from('fake-level-meta'))
    fs.mkdirSync(path.join(saveDir, 'Players'), { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'Players', 'fake-player.sav'), Buffer.from('fake-player'))
    fs.writeFileSync(
      path.join(pal, 'steamapps', 'appmanifest_2394010.acf'),
      `"AppState"\n{\n\t"appid"\t\t"2394010"\n\t"buildid"\t\t"${FAKE_BUILD_ID}"\n}\n`,
    )
    this.installed = true
    this.buildId = FAKE_BUILD_ID
  }

  // --- journal ------------------------------------------------------------

  log(line: string): void {
    const stamped = line
    this.journalLines.push(stamped)
    if (this.journalLines.length > 500) this.journalLines.shift()
    this.emitter.emit('line', stamped)
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
    if (!this.installed) {
      this.state = 'failed'
      this.log('[systemd] palworld.service: Failed — PalServer.sh not found')
      return
    }
    this.state = 'activating'
    this.log('[systemd] Starting palworld.service...')
    await sleep(1200)
    this.state = 'active'
    this.activeEnterAtMs = Date.now()
    this.log('[PalServer] Rcon disabled, REST API listening on 127.0.0.1:8212')
    this.log('[PalServer] World loaded: ' + FAKE_WORLD_ID)
    this.tick = setInterval(() => {
      if (this.state === 'active') this.log(`[PalServer] tick players=2 fps=59.8`)
    }, 5000)
  }

  async stop(): Promise<void> {
    if (this.state === 'inactive') return
    this.state = 'deactivating'
    this.log('[systemd] Stopping palworld.service...')
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    await sleep(800)
    this.state = 'inactive'
    this.activeEnterAtMs = null
    this.log('[systemd] palworld.service: Deactivated successfully.')
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

export interface FakeServices {
  gameControl: GameControl
  palRest: PalRest
  journal: Journal
  steamcmd: SteamCmd
  dispose(): void
}

export function createFakeServices(env: Env, logger: Logger): FakeServices {
  const world = new FakeWorld(env)
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
    if (world.state !== 'active') throw new Error('Palworld REST API is unreachable (game down)')
  }

  const palRest: PalRest = {
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

  const journal: Journal = {
    buffer: () => world.journalBuffer(),
    subscribe: (cb) => world.onLine(cb),
    start: () => {},
    stop: () => {},
  }

  const steamcmd: SteamCmd = {
    run: async (kind, sink: OpSink) => {
      sink.line(`steamcmd +login anonymous +app_update 2394010 validate (${kind})`)
      sink.line('Steam Console Client (c) Valve Corporation - version 1734112433')
      for (let pct = 0; pct <= 100; pct += 10) {
        sink.progress(pct)
        sink.line(` Update state (0x61) downloading, progress: ${pct.toFixed(2)} (${pct} of 100)`)
        await sleep(400)
      }
      world.install()
      sink.line(`Success! App '2394010' fully installed.`)
      logger.info('fake steamcmd finished', { kind })
    },
    installedBuildId: () => Promise.resolve(world.buildId),
  }

  return { gameControl, palRest, journal, steamcmd, dispose: () => world.dispose() }
}
