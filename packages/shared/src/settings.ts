import { z } from 'zod'

// PalWorldSettings.ini contract. The file is a single
// `[/Script/Pal.PalGameWorldSettings]` section whose `OptionSettings=(K=V,…)`
// tuple holds every gameplay/server key. The server-side parser
// (apps/server settings-ini service) preserves unknown keys verbatim;
// this module types the keys we render as a structured form.

// Value kinds we know how to render + coerce. `string` values are
// double-quoted in the tuple; bools serialize as True/False.
export type PalKeyKind = 'bool' | 'int' | 'float' | 'string' | 'enum'

// Display sections for the structured settings form, in render order.
export const SETTINGS_CATEGORIES = [
  'Server & Network',
  'World & Gameplay',
  'Players',
  'Pals',
  'Base & Building',
  'PvP & Raids',
  'Guilds',
] as const
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]

export interface PalKeySpec {
  kind: PalKeyKind
  category: SettingsCategory
  enumValues?: readonly string[]
  // Managed keys are enforced by the panel on every write and rendered
  // read-only in the UI (they keep the panel's control channel alive).
  managed?: boolean
  // Editing this key requires a game restart to apply (all of them do —
  // Palworld reads the ini at process start — but the flag lets the UI
  // say so explicitly per field if we ever find hot-reloaded keys).
  label?: string
}

// The panel-critical invariants, enforced last on every write so a user
// edit can never lock the panel out of the game's REST API.
export const MANAGED_KEYS = ['RESTAPIEnabled', 'RESTAPIPort', 'AdminPassword', 'RCONEnabled'] as const
export type ManagedKey = (typeof MANAGED_KEYS)[number]

// Known OptionSettings keys (v1 pragmatic subset — unknown keys pass
// through untouched, so this list only bounds what the structured form
// shows, not what the file may contain).
export const PAL_KEY_SPECS: Record<string, PalKeySpec> = {
  // Server & Network — identity/access + the panel control channel
  ServerName: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  ServerDescription: { kind: 'string', category: 'Server & Network', label: 'Server description' },
  ServerPassword: { kind: 'string', category: 'Server & Network', label: 'Join password' },
  AdminPassword: { kind: 'string', category: 'Server & Network', managed: true, label: 'Admin password (panel-managed)' },
  PublicIP: { kind: 'string', category: 'Server & Network', label: 'Public IP' },
  PublicPort: { kind: 'int', category: 'Server & Network', label: 'Public port' },
  ServerPlayerMaxNum: { kind: 'int', category: 'Server & Network', label: 'Max players' },
  CoopPlayerMaxNum: { kind: 'int', category: 'Server & Network', label: 'Co-op max players' },
  Region: { kind: 'string', category: 'Server & Network', label: 'Region' },
  bUseAuth: { kind: 'bool', category: 'Server & Network', label: 'Use auth' },
  BanListURL: { kind: 'string', category: 'Server & Network', label: 'Ban list URL' },
  AllowConnectPlatform: { kind: 'string', category: 'Server & Network', label: 'Allowed platform' },
  bShowPlayerList: { kind: 'bool', category: 'Server & Network', label: 'Show player list' },
  LogFormatType: { kind: 'string', category: 'Server & Network', label: 'Log format' },
  RESTAPIEnabled: { kind: 'bool', category: 'Server & Network', managed: true, label: 'REST API (panel-managed)' },
  RESTAPIPort: { kind: 'int', category: 'Server & Network', managed: true, label: 'REST API port (panel-managed)' },
  RCONEnabled: { kind: 'bool', category: 'Server & Network', managed: true, label: 'RCON (panel-managed, off)' },
  RCONPort: { kind: 'int', category: 'Server & Network', label: 'RCON port' },
  bIsMultiplay: { kind: 'bool', category: 'Server & Network', label: 'Multiplayer' },
  AutoSaveSpan: { kind: 'float', category: 'Server & Network', label: 'Auto-save interval (s)' },
  bIsUseBackupSaveData: { kind: 'bool', category: 'Server & Network', label: 'Game-native save backup' },
  ChatPostLimitPerMinute: { kind: 'int', category: 'Server & Network', label: 'Chat msgs/min limit' },

  // World & Gameplay — difficulty, world rates, items, travel
  Difficulty: { kind: 'enum', category: 'World & Gameplay', enumValues: ['None', 'Normal', 'Difficult'], label: 'Difficulty' },
  RandomizerType: { kind: 'enum', category: 'World & Gameplay', enumValues: ['None', 'Region', 'All'], label: 'Randomizer' },
  RandomizerSeed: { kind: 'string', category: 'World & Gameplay', label: 'Randomizer seed' },
  bIsRandomizerPalLevelRandom: { kind: 'bool', category: 'World & Gameplay', label: 'Randomize Pal levels' },
  DayTimeSpeedRate: { kind: 'float', category: 'World & Gameplay', label: 'Day speed' },
  NightTimeSpeedRate: { kind: 'float', category: 'World & Gameplay', label: 'Night speed' },
  ExpRate: { kind: 'float', category: 'World & Gameplay', label: 'XP rate' },
  WorkSpeedRate: { kind: 'float', category: 'World & Gameplay', label: 'Work speed' },
  ItemWeightRate: { kind: 'float', category: 'World & Gameplay', label: 'Item weight' },
  SupplyDropSpan: { kind: 'int', category: 'World & Gameplay', label: 'Supply drop interval (min)' },
  DropItemMaxNum: { kind: 'int', category: 'World & Gameplay', label: 'Max dropped items' },
  DropItemMaxNum_UNKO: { kind: 'int', category: 'World & Gameplay', label: 'Max dropped UNKO' },
  DropItemAliveMaxHours: { kind: 'float', category: 'World & Gameplay', label: 'Dropped item lifetime (h)' },
  bActiveUNKO: { kind: 'bool', category: 'World & Gameplay', label: 'UNKO' },
  bEnableFastTravel: { kind: 'bool', category: 'World & Gameplay', label: 'Fast travel' },
  bIsStartLocationSelectByMap: { kind: 'bool', category: 'World & Gameplay', label: 'Map start select' },

  // Players — survival rates, death rules, input assists
  PlayerDamageRateAttack: { kind: 'float', category: 'Players', label: 'Player damage dealt' },
  PlayerDamageRateDefense: { kind: 'float', category: 'Players', label: 'Player damage taken' },
  PlayerStomachDecreaceRate: { kind: 'float', category: 'Players', label: 'Player hunger drain' },
  PlayerStaminaDecreaceRate: { kind: 'float', category: 'Players', label: 'Player stamina drain' },
  PlayerAutoHPRegeneRate: { kind: 'float', category: 'Players', label: 'Player HP regen' },
  PlayerAutoHpRegeneRateInSleep: { kind: 'float', category: 'Players', label: 'Player HP regen (sleep)' },
  DeathPenalty: {
    kind: 'enum',
    category: 'Players',
    enumValues: ['None', 'Item', 'ItemAndEquipment', 'All'],
    label: 'Death penalty',
  },
  bHardcore: { kind: 'bool', category: 'Players', label: 'Hardcore mode' },
  bCharacterRecreateInHardcore: { kind: 'bool', category: 'Players', label: 'Hardcore char recreate' },
  bExistPlayerAfterLogout: { kind: 'bool', category: 'Players', label: 'Body persists on logout' },
  bEnableNonLoginPenalty: { kind: 'bool', category: 'Players', label: 'Non-login penalty' },
  bEnableAimAssistPad: { kind: 'bool', category: 'Players', label: 'Aim assist (pad)' },
  bEnableAimAssistKeyboard: { kind: 'bool', category: 'Players', label: 'Aim assist (kb)' },

  // Pals — capture, spawns, survival rates, breeding
  PalCaptureRate: { kind: 'float', category: 'Pals', label: 'Pal capture rate' },
  PalSpawnNumRate: { kind: 'float', category: 'Pals', label: 'Pal spawn rate' },
  PalDamageRateAttack: { kind: 'float', category: 'Pals', label: 'Pal damage dealt' },
  PalDamageRateDefense: { kind: 'float', category: 'Pals', label: 'Pal damage taken' },
  PalStomachDecreaceRate: { kind: 'float', category: 'Pals', label: 'Pal hunger drain' },
  PalStaminaDecreaceRate: { kind: 'float', category: 'Pals', label: 'Pal stamina drain' },
  PalAutoHPRegeneRate: { kind: 'float', category: 'Pals', label: 'Pal HP regen' },
  PalAutoHpRegeneRateInSleep: { kind: 'float', category: 'Pals', label: 'Pal HP regen (sleep)' },
  PalEggDefaultHatchingTime: { kind: 'float', category: 'Pals', label: 'Egg hatch time (h)' },
  bPalLost: { kind: 'bool', category: 'Pals', label: 'Pals lost on death' },

  // Base & Building — structures, base camps, gathering
  BuildObjectHpRate: { kind: 'float', category: 'Base & Building', label: 'Structure HP' },
  BuildObjectDamageRate: { kind: 'float', category: 'Base & Building', label: 'Structure damage' },
  BuildObjectDeteriorationDamageRate: { kind: 'float', category: 'Base & Building', label: 'Structure decay' },
  bBuildAreaLimit: { kind: 'bool', category: 'Base & Building', label: 'Limit build area' },
  BaseCampMaxNum: { kind: 'int', category: 'Base & Building', label: 'Max base camps' },
  BaseCampWorkerMaxNum: { kind: 'int', category: 'Base & Building', label: 'Max base workers' },
  CollectionDropRate: { kind: 'float', category: 'Base & Building', label: 'Gather drop rate' },
  CollectionObjectHpRate: { kind: 'float', category: 'Base & Building', label: 'Gather node HP' },
  CollectionObjectRespawnSpeedRate: { kind: 'float', category: 'Base & Building', label: 'Gather respawn speed' },
  EnemyDropItemRate: { kind: 'float', category: 'Base & Building', label: 'Enemy drop rate' },

  // PvP & Raids — player-vs-player and guild-vs-guild rules
  bIsPvP: { kind: 'bool', category: 'PvP & Raids', label: 'PvP mode' },
  bEnablePlayerToPlayerDamage: { kind: 'bool', category: 'PvP & Raids', label: 'PvP damage' },
  bEnableFriendlyFire: { kind: 'bool', category: 'PvP & Raids', label: 'Friendly fire' },
  bEnableInvaderEnemy: { kind: 'bool', category: 'PvP & Raids', label: 'Raids' },
  bCanPickupOtherGuildDeathPenaltyDrop: { kind: 'bool', category: 'PvP & Raids', label: 'Loot other guild drops' },
  bEnableDefenseOtherGuildPlayer: { kind: 'bool', category: 'PvP & Raids', label: 'Defend vs other guilds' },
  bInvisibleOtherGuildBaseCampAreaFX: { kind: 'bool', category: 'PvP & Raids', label: 'Hide other-guild base FX' },

  // Guilds
  GuildPlayerMaxNum: { kind: 'int', category: 'Guilds', label: 'Max guild members' },
  BaseCampMaxNumInGuild: { kind: 'int', category: 'Guilds', label: 'Max bases per guild' },
  bAutoResetGuildNoOnlinePlayers: { kind: 'bool', category: 'Guilds', label: 'Auto-reset idle guilds' },
  AutoResetGuildTimeNoOnlinePlayers: { kind: 'float', category: 'Guilds', label: 'Idle guild reset (h)' },
}

// --- Enshrouded (enshrouded_server.json) ------------------------------------
// The file is nested JSON: top-level scalars, a `gameSettings` object of
// tuning keys, and a `userGroups` array (roles + passwords). The panel
// flattens scalars to dot-path keys (`gameSettings.playerHealthFactor`);
// non-scalar values (userGroups) are raw-editor-only but preserved
// verbatim on every structured write. Specs are advisory: keys the game
// adds across patches fall into the read-only "preserved verbatim" pane.

export const ENSHROUDED_SETTINGS_CATEGORIES = [
  'Server & Network',
  'Difficulty & Survival',
  'Progression & Rates',
  'Enemies & Bosses',
  'World & Time',
] as const
export type EnshroudedSettingsCategory = (typeof ENSHROUDED_SETTINGS_CATEGORIES)[number]

// Panel-enforced on every write so the file can never drift from the
// registry's ports or move the save/log dirs out from under backups.
// `gamePort` is only enforced when the key exists (newer builds dropped it).
export const ENSHROUDED_MANAGED_KEYS = ['ip', 'queryPort', 'gamePort', 'saveDirectory', 'logDirectory'] as const

export interface EnshroudedKeySpec {
  kind: PalKeyKind
  category: EnshroudedSettingsCategory
  enumValues?: readonly string[]
  managed?: boolean
  label?: string
}

const eFloat = (category: EnshroudedSettingsCategory, label: string): EnshroudedKeySpec => ({
  kind: 'float',
  category,
  label,
})

export const ENSHROUDED_KEY_SPECS: Record<string, EnshroudedKeySpec> = {
  // Server & Network — identity, access, managed net/path keys
  name: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  password: { kind: 'string', category: 'Server & Network', label: 'Join password (legacy)' },
  slotCount: { kind: 'int', category: 'Server & Network', label: 'Max players' },
  ip: { kind: 'string', category: 'Server & Network', managed: true, label: 'Bind IP (panel-managed)' },
  queryPort: { kind: 'int', category: 'Server & Network', managed: true, label: 'Query port (panel-managed)' },
  gamePort: { kind: 'int', category: 'Server & Network', managed: true, label: 'Game port (panel-managed)' },
  saveDirectory: { kind: 'string', category: 'Server & Network', managed: true, label: 'Save dir (panel-managed)' },
  logDirectory: { kind: 'string', category: 'Server & Network', managed: true, label: 'Log dir (panel-managed)' },
  enableVoiceChat: { kind: 'bool', category: 'Server & Network', label: 'Voice chat' },
  enableTextChat: { kind: 'bool', category: 'Server & Network', label: 'Text chat' },
  gameSettingsPreset: {
    kind: 'enum',
    category: 'Difficulty & Survival',
    enumValues: ['Default', 'Relaxed', 'Hard', 'Survival', 'Custom'],
    label: 'Difficulty preset (gameSettings apply only when Custom)',
  },

  // Difficulty & Survival
  'gameSettings.playerHealthFactor': eFloat('Difficulty & Survival', 'Player health'),
  'gameSettings.playerManaFactor': eFloat('Difficulty & Survival', 'Player mana'),
  'gameSettings.playerStaminaFactor': eFloat('Difficulty & Survival', 'Player stamina'),
  'gameSettings.playerBodyHeatFactor': eFloat('Difficulty & Survival', 'Player body heat'),
  'gameSettings.enableDurability': { kind: 'bool', category: 'Difficulty & Survival', label: 'Equipment durability' },
  'gameSettings.enableStarvingDebuff': { kind: 'bool', category: 'Difficulty & Survival', label: 'Starving debuff' },
  'gameSettings.foodBuffDurationFactor': eFloat('Difficulty & Survival', 'Food buff duration'),
  'gameSettings.fromHungerToStarving': {
    kind: 'int',
    category: 'Difficulty & Survival',
    label: 'Hunger → starving (ns)',
  },
  'gameSettings.shroudTimeFactor': eFloat('Difficulty & Survival', 'Shroud time'),
  'gameSettings.tombstoneMode': {
    kind: 'enum',
    category: 'Difficulty & Survival',
    enumValues: ['AddBackpackMaterials', 'Everything', 'NoTombstone'],
    label: 'Tombstone mode',
  },
  'gameSettings.enableGliderTurbulences': {
    kind: 'bool',
    category: 'Difficulty & Survival',
    label: 'Glider turbulences',
  },

  // Progression & Rates
  'gameSettings.miningDamageFactor': eFloat('Progression & Rates', 'Mining damage'),
  'gameSettings.plantGrowthSpeedFactor': eFloat('Progression & Rates', 'Plant growth speed'),
  'gameSettings.resourceDropStackAmountFactor': eFloat('Progression & Rates', 'Resource drop stacks'),
  'gameSettings.factoryProductionSpeedFactor': eFloat('Progression & Rates', 'Factory production speed'),
  'gameSettings.perkUpgradeRecyclingFactor': eFloat('Progression & Rates', 'Perk upgrade recycling'),
  'gameSettings.perkCostFactor': eFloat('Progression & Rates', 'Perk cost'),
  'gameSettings.experienceCombatFactor': eFloat('Progression & Rates', 'Combat XP'),
  'gameSettings.experienceMiningFactor': eFloat('Progression & Rates', 'Mining XP'),
  'gameSettings.experienceExplorationQuestsFactor': eFloat('Progression & Rates', 'Exploration/quest XP'),

  // Enemies & Bosses
  'gameSettings.randomSpawnerAmount': {
    kind: 'enum',
    category: 'Enemies & Bosses',
    enumValues: ['Few', 'Normal', 'Many', 'Extreme'],
    label: 'Enemy spawn amount',
  },
  'gameSettings.aggroPoolAmount': {
    kind: 'enum',
    category: 'Enemies & Bosses',
    enumValues: ['Few', 'Normal', 'Many', 'Extreme'],
    label: 'Aggro pool',
  },
  'gameSettings.enemyDamageFactor': eFloat('Enemies & Bosses', 'Enemy damage'),
  'gameSettings.enemyHealthFactor': eFloat('Enemies & Bosses', 'Enemy health'),
  'gameSettings.enemyStaminaFactor': eFloat('Enemies & Bosses', 'Enemy stamina'),
  'gameSettings.enemyPerceptionRangeFactor': eFloat('Enemies & Bosses', 'Enemy perception range'),
  'gameSettings.bossDamageFactor': eFloat('Enemies & Bosses', 'Boss damage'),
  'gameSettings.bossHealthFactor': eFloat('Enemies & Bosses', 'Boss health'),
  'gameSettings.threatBonus': eFloat('Enemies & Bosses', 'Threat bonus'),
  'gameSettings.pacifyAllEnemies': { kind: 'bool', category: 'Enemies & Bosses', label: 'Pacify all enemies' },
  'gameSettings.tamingStartleRepercussion': {
    kind: 'enum',
    category: 'Enemies & Bosses',
    enumValues: ['KeepProgress', 'LoseSomeProgress', 'LoseAllProgress'],
    label: 'Taming startle repercussion',
  },

  // World & Time
  'gameSettings.dayTimeDuration': { kind: 'int', category: 'World & Time', label: 'Day duration (ns)' },
  'gameSettings.nightTimeDuration': { kind: 'int', category: 'World & Time', label: 'Night duration (ns)' },
  'gameSettings.weatherFrequency': {
    kind: 'enum',
    category: 'World & Time',
    enumValues: ['Disabled', 'Rare', 'Normal', 'Often'],
    label: 'Weather frequency',
  },
}

// --- generic per-game spec tables -------------------------------------------
// Every game past Palworld/Enshrouded describes its settings file with the
// same shape: a key → spec table plus that game's category render order.
// The server's settings adapters read these; the web Settings page is
// spec-driven and needs no per-game code.

export interface GameKeySpec {
  kind: PalKeyKind
  // One of the game's own categories (see the *_SETTINGS_CATEGORIES below).
  category: string
  enumValues?: readonly string[]
  // Managed keys are enforced by the panel on every write and rendered
  // read-only in the UI (they keep the panel's control channel alive).
  managed?: boolean
  label?: string
}

export type GameKeySpecs = Record<string, GameKeySpec>

// --- Valheim (panel-owned rallypoint-launch.conf) ---------------------------
// Valheim has no config file: everything is a launch flag, so the panel owns
// a small conf the generated start.sh dot-sources. Keys are the flags.

export const VALHEIM_SETTINGS_CATEGORIES = ['Server & Network', 'World & Saves'] as const

export const VALHEIM_KEY_SPECS: GameKeySpecs = {
  '-name': { kind: 'string', category: 'Server & Network', label: 'Server name' },
  '-password': { kind: 'string', category: 'Server & Network', label: 'Join password (5+ chars, or empty)' },
  '-public': { kind: 'enum', category: 'Server & Network', enumValues: ['0', '1'], label: 'List in server browser' },
  '-crossplay': { kind: 'bool', category: 'Server & Network', label: 'Crossplay (PlayFab)' },
  '-port': { kind: 'int', category: 'Server & Network', managed: true, label: 'Game port (panel-managed)' },
  '-world': { kind: 'string', category: 'World & Saves', label: 'World name' },
  '-saveinterval': { kind: 'int', category: 'World & Saves', label: 'Auto-save interval (s)' },
  '-backups': { kind: 'int', category: 'World & Saves', label: 'Backups kept' },
}

// --- Rust (server/rallypoint/cfg/server.cfg convars) ------------------------

export const RUST_SETTINGS_CATEGORIES = ['Server & Network', 'World & Gameplay'] as const

export const RUST_KEY_SPECS: GameKeySpecs = {
  'server.hostname': { kind: 'string', category: 'Server & Network', label: 'Server name' },
  'server.description': { kind: 'string', category: 'Server & Network', label: 'Server description' },
  'server.url': { kind: 'string', category: 'Server & Network', label: 'Website URL' },
  'server.headerimage': { kind: 'string', category: 'Server & Network', label: 'Header image URL' },
  'server.saveinterval': { kind: 'int', category: 'Server & Network', label: 'Auto-save interval (s)' },
  'server.globalchat': { kind: 'bool', category: 'Server & Network', label: 'Global chat' },
  'server.pve': { kind: 'bool', category: 'World & Gameplay', label: 'PvE mode' },
  'server.stability': { kind: 'bool', category: 'World & Gameplay', label: 'Building stability' },
  'server.radiation': { kind: 'bool', category: 'World & Gameplay', label: 'Radiation' },
  'decay.scale': { kind: 'float', category: 'World & Gameplay', label: 'Decay rate' },
  'craft.instant': { kind: 'bool', category: 'World & Gameplay', label: 'Instant crafting' },
  'spawn.max_density': { kind: 'float', category: 'World & Gameplay', label: 'Spawn density' },
  // Launch-conf keys the panel maintains so RCON stays reachable. They live
  // in rallypoint-launch.conf, not server.cfg — listed so the UI can explain
  // why the RCON port/password are not editable.
  '+rcon.port': { kind: 'int', category: 'Server & Network', managed: true, label: 'RCON port (panel-managed)' },
  '+rcon.password': { kind: 'string', category: 'Server & Network', managed: true, label: 'RCON password (panel-managed)' },
  '+rcon.web': { kind: 'int', category: 'Server & Network', managed: true, label: 'RCON websocket (panel-managed)' },
}

// --- ARK: Survival Evolved (GameUserSettings.ini) ---------------------------
// Sectioned ini: keys are addressed as `Section/Key`, split at the LAST
// slash so UE's `[/Script/Engine.GameSession]` sections work.

export const ARK_SETTINGS_CATEGORIES = [
  'Server & Network',
  'World & Rates',
  'Players & Dinos',
  'PvP & Structures',
] as const

export const ARK_KEY_SPECS: GameKeySpecs = {
  'SessionSettings/SessionName': { kind: 'string', category: 'Server & Network', label: 'Session name' },
  'ServerSettings/ServerPassword': { kind: 'string', category: 'Server & Network', label: 'Join password' },
  'ServerSettings/ServerAdminPassword': {
    kind: 'string',
    category: 'Server & Network',
    managed: true,
    label: 'Admin password (panel-managed)',
  },
  'ServerSettings/RCONEnabled': {
    kind: 'bool',
    category: 'Server & Network',
    managed: true,
    label: 'RCON (panel-managed)',
  },
  'ServerSettings/RCONPort': {
    kind: 'int',
    category: 'Server & Network',
    managed: true,
    label: 'RCON port (panel-managed)',
  },
  '/Script/Engine.GameSession/MaxPlayers': { kind: 'int', category: 'Server & Network', label: 'Max players' },
  'ServerSettings/ServerCrosshair': { kind: 'bool', category: 'Server & Network', label: 'Crosshair' },
  'ServerSettings/GlobalVoiceChat': { kind: 'bool', category: 'Server & Network', label: 'Global voice chat' },
  'ServerSettings/ProximityChat': { kind: 'bool', category: 'Server & Network', label: 'Proximity chat' },
  'ServerSettings/ShowMapPlayerLocation': { kind: 'bool', category: 'Server & Network', label: 'Show map location' },
  'ServerSettings/KickIdlePlayersPeriod': { kind: 'float', category: 'Server & Network', label: 'Kick idle after (s)' },
  'ServerSettings/AutoSavePeriodMinutes': { kind: 'float', category: 'Server & Network', label: 'Auto-save (min)' },

  'ServerSettings/DifficultyOffset': { kind: 'float', category: 'World & Rates', label: 'Difficulty offset' },
  'ServerSettings/XPMultiplier': { kind: 'float', category: 'World & Rates', label: 'XP rate' },
  'ServerSettings/TamingSpeedMultiplier': { kind: 'float', category: 'World & Rates', label: 'Taming speed' },
  'ServerSettings/HarvestAmountMultiplier': { kind: 'float', category: 'World & Rates', label: 'Harvest amount' },
  'ServerSettings/DayCycleSpeedScale': { kind: 'float', category: 'World & Rates', label: 'Day cycle speed' },
  'ServerSettings/DayTimeSpeedScale': { kind: 'float', category: 'World & Rates', label: 'Daytime speed' },
  'ServerSettings/NightTimeSpeedScale': { kind: 'float', category: 'World & Rates', label: 'Night speed' },

  'ServerSettings/PlayerDamageMultiplier': { kind: 'float', category: 'Players & Dinos', label: 'Player damage' },
  'ServerSettings/DinoDamageMultiplier': { kind: 'float', category: 'Players & Dinos', label: 'Dino damage' },
  'ServerSettings/PlayerCharacterFoodDrainMultiplier': {
    kind: 'float',
    category: 'Players & Dinos',
    label: 'Player food drain',
  },
  'ServerSettings/PlayerCharacterWaterDrainMultiplier': {
    kind: 'float',
    category: 'Players & Dinos',
    label: 'Player water drain',
  },
  'ServerSettings/DinoCharacterFoodDrainMultiplier': {
    kind: 'float',
    category: 'Players & Dinos',
    label: 'Dino food drain',
  },
  'ServerSettings/AllowThirdPersonPlayer': { kind: 'bool', category: 'Players & Dinos', label: 'Third person' },

  'ServerSettings/ServerPVE': { kind: 'bool', category: 'PvP & Structures', label: 'PvE mode' },
  'ServerSettings/EnablePvPGamma': { kind: 'bool', category: 'PvP & Structures', label: 'PvP gamma' },
  'ServerSettings/StructureResistanceMultiplier': {
    kind: 'float',
    category: 'PvP & Structures',
    label: 'Structure resistance',
  },
  'ServerSettings/StructureDamageMultiplier': {
    kind: 'float',
    category: 'PvP & Structures',
    label: 'Structure damage',
  },
  'ServerSettings/AllowCaveBuildingPvE': { kind: 'bool', category: 'PvP & Structures', label: 'Cave building (PvE)' },
  'ServerSettings/NoTributeDownloads': { kind: 'bool', category: 'PvP & Structures', label: 'No tribute downloads' },
}

// --- 7 Days to Die (serverconfig.xml) ---------------------------------------
// Flat `<property name="X" value="Y"/>` lines; keys are the property names.

export const SDTD_SETTINGS_CATEGORIES = [
  'Server & Network',
  'World',
  'Gameplay & Difficulty',
  'Loot & Progression',
] as const

export const SDTD_KEY_SPECS: GameKeySpecs = {
  ServerName: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  ServerDescription: { kind: 'string', category: 'Server & Network', label: 'Server description' },
  ServerWebsiteURL: { kind: 'string', category: 'Server & Network', label: 'Website URL' },
  ServerPassword: { kind: 'string', category: 'Server & Network', label: 'Join password' },
  ServerMaxPlayerCount: { kind: 'int', category: 'Server & Network', label: 'Max players' },
  ServerVisibility: {
    kind: 'enum',
    category: 'Server & Network',
    enumValues: ['0', '1', '2'],
    label: 'Visibility (0 private, 2 public)',
  },
  EACEnabled: { kind: 'bool', category: 'Server & Network', label: 'EasyAntiCheat' },
  TelnetEnabled: { kind: 'bool', category: 'Server & Network', managed: true, label: 'Telnet (panel-managed)' },
  TelnetPort: { kind: 'int', category: 'Server & Network', managed: true, label: 'Telnet port (panel-managed)' },
  TelnetPassword: {
    kind: 'string',
    category: 'Server & Network',
    managed: true,
    label: 'Telnet password (panel-managed)',
  },
  SaveGameFolder: { kind: 'string', category: 'Server & Network', managed: true, label: 'Save folder (panel-managed)' },

  GameWorld: { kind: 'string', category: 'World', label: 'World' },
  WorldGenSeed: { kind: 'string', category: 'World', label: 'World seed' },
  WorldGenSize: { kind: 'int', category: 'World', label: 'World size' },
  GameName: { kind: 'string', category: 'World', label: 'Save game name' },
  DayNightLength: { kind: 'int', category: 'World', label: 'Day length (real min)' },
  DayLightLength: { kind: 'int', category: 'World', label: 'Daylight hours' },

  GameDifficulty: {
    kind: 'enum',
    category: 'Gameplay & Difficulty',
    enumValues: ['0', '1', '2', '3', '4', '5'],
    label: 'Difficulty',
  },
  ZombiesRun: {
    kind: 'enum',
    category: 'Gameplay & Difficulty',
    enumValues: ['0', '1', '2'],
    label: 'Zombie speed (day)',
  },
  EnemyDifficulty: {
    kind: 'enum',
    category: 'Gameplay & Difficulty',
    enumValues: ['0', '1'],
    label: 'Enemy difficulty',
  },
  BlockDamagePlayer: { kind: 'int', category: 'Gameplay & Difficulty', label: 'Block damage (player) %' },
  PlayerKillingMode: {
    kind: 'enum',
    category: 'Gameplay & Difficulty',
    enumValues: ['0', '1', '2', '3'],
    label: 'Player killing',
  },
  MaxSpawnedZombies: { kind: 'int', category: 'Gameplay & Difficulty', label: 'Max spawned zombies' },
  DropOnDeath: {
    kind: 'enum',
    category: 'Gameplay & Difficulty',
    enumValues: ['0', '1', '2', '3', '4'],
    label: 'Drop on death',
  },

  XPMultiplier: { kind: 'int', category: 'Loot & Progression', label: 'XP rate %' },
  LootAbundance: { kind: 'int', category: 'Loot & Progression', label: 'Loot abundance %' },
  LootRespawnDays: { kind: 'int', category: 'Loot & Progression', label: 'Loot respawn (days)' },
  AirDropFrequency: { kind: 'int', category: 'Loot & Progression', label: 'Air drop (h, 0 off)' },
  LandClaimSize: { kind: 'int', category: 'Loot & Progression', label: 'Land claim size' },
  BedrollDeadZoneSize: { kind: 'int', category: 'Loot & Progression', label: 'Bedroll dead zone' },
  PersistentPlayerProfiles: { kind: 'bool', category: 'Loot & Progression', label: 'Persistent profiles' },
}

// --- Project Zomboid (Zomboid/Server/rallypoint.ini) ------------------------
// `Key=Value` with `#` comments, no sections.

export const ZOMBOID_SETTINGS_CATEGORIES = ['Server & Network', 'Players & Rules', 'World & Saves'] as const

export const ZOMBOID_KEY_SPECS: GameKeySpecs = {
  PublicName: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  PublicDescription: { kind: 'string', category: 'Server & Network', label: 'Server description' },
  Password: { kind: 'string', category: 'Server & Network', label: 'Join password' },
  Public: { kind: 'bool', category: 'Server & Network', label: 'List in server browser' },
  Open: { kind: 'bool', category: 'Server & Network', label: 'Open (no whitelist)' },
  MaxPlayers: { kind: 'int', category: 'Server & Network', label: 'Max players' },
  DefaultPort: { kind: 'int', category: 'Server & Network', label: 'Game port' },
  UDPPort: { kind: 'int', category: 'Server & Network', label: 'UDP port' },
  PingLimit: { kind: 'int', category: 'Server & Network', label: 'Ping limit (ms)' },
  RCONPort: { kind: 'int', category: 'Server & Network', managed: true, label: 'RCON port (panel-managed)' },
  RCONPassword: {
    kind: 'string',
    category: 'Server & Network',
    managed: true,
    label: 'RCON password (panel-managed)',
  },

  PVP: { kind: 'bool', category: 'Players & Rules', label: 'PvP' },
  SafetySystem: { kind: 'bool', category: 'Players & Rules', label: 'PvP safety system' },
  SafetyToggleTimer: { kind: 'int', category: 'Players & Rules', label: 'Safety toggle timer (s)' },
  DisplayUserName: { kind: 'bool', category: 'Players & Rules', label: 'Show usernames' },
  GlobalChat: { kind: 'bool', category: 'Players & Rules', label: 'Global chat' },
  ServerWelcomeMessage: { kind: 'string', category: 'Players & Rules', label: 'Welcome message' },
  SpawnItems: { kind: 'string', category: 'Players & Rules', label: 'Spawn items' },

  PauseEmpty: { kind: 'bool', category: 'World & Saves', label: 'Pause when empty' },
  NoFire: { kind: 'bool', category: 'World & Saves', label: 'Disable fire spread' },
  AllowDestructionBySledgehammer: { kind: 'bool', category: 'World & Saves', label: 'Sledgehammer destruction' },
  SaveWorldEveryMinutes: { kind: 'int', category: 'World & Saves', label: 'Save world every (min)' },
  BackupsOnStart: { kind: 'bool', category: 'World & Saves', label: 'Backup on start' },
  Mods: { kind: 'string', category: 'World & Saves', label: 'Mod ids (;-separated)' },
  WorkshopItems: { kind: 'string', category: 'World & Saves', label: 'Workshop ids (;-separated)' },
}

// --- Source dedicated servers (server.cfg) — TF2 + CS2 ----------------------
// Space-separated `convar value` lines with `//` comments; values that
// contain spaces are double-quoted.

export const SOURCE_CFG_SETTINGS_CATEGORIES = ['Server & Network', 'Match Rules', 'Gameplay'] as const

export const SOURCE_CFG_KEY_SPECS: GameKeySpecs = {
  hostname: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  sv_password: { kind: 'string', category: 'Server & Network', label: 'Join password' },
  rcon_password: {
    kind: 'string',
    category: 'Server & Network',
    managed: true,
    label: 'RCON password (panel-managed)',
  },
  sv_lan: { kind: 'enum', category: 'Server & Network', enumValues: ['0', '1'], label: 'LAN mode' },
  sv_region: { kind: 'int', category: 'Server & Network', label: 'Region code' },
  sv_downloadurl: { kind: 'string', category: 'Server & Network', label: 'Fast download URL' },
  sv_hibernate_when_empty: {
    kind: 'enum',
    category: 'Server & Network',
    enumValues: ['0', '1'],
    label: 'Hibernate when empty',
  },

  mp_timelimit: { kind: 'int', category: 'Match Rules', label: 'Map time limit (min)' },
  mp_maxrounds: { kind: 'int', category: 'Match Rules', label: 'Max rounds' },
  mp_roundtime: { kind: 'float', category: 'Match Rules', label: 'Round time (min)' },
  mp_freezetime: { kind: 'int', category: 'Match Rules', label: 'Freeze time (s)' },
  mp_warmuptime: { kind: 'int', category: 'Match Rules', label: 'Warmup time (s)' },
  mp_friendlyfire: { kind: 'enum', category: 'Match Rules', enumValues: ['0', '1'], label: 'Friendly fire' },
  mp_autoteambalance: { kind: 'enum', category: 'Match Rules', enumValues: ['0', '1'], label: 'Auto team balance' },
  mp_teams_unbalance_limit: { kind: 'int', category: 'Match Rules', label: 'Team unbalance limit' },

  sv_cheats: { kind: 'enum', category: 'Gameplay', enumValues: ['0', '1'], label: 'Cheats' },
  sv_pure: { kind: 'enum', category: 'Gameplay', enumValues: ['-1', '0', '1', '2'], label: 'Pure server' },
  sv_gravity: { kind: 'int', category: 'Gameplay', label: 'Gravity' },
  sv_alltalk: { kind: 'enum', category: 'Gameplay', enumValues: ['0', '1'], label: 'All talk' },
  sv_voiceenable: { kind: 'enum', category: 'Gameplay', enumValues: ['0', '1'], label: 'Voice chat' },
  sv_pausable: { kind: 'enum', category: 'Gameplay', enumValues: ['0', '1'], label: 'Pausable' },
  sv_allow_votes: { kind: 'enum', category: 'Gameplay', enumValues: ['0', '1'], label: 'Allow votes' },
  bot_quota: { kind: 'int', category: 'Gameplay', label: 'Bot count' },
}

// --- Unturned (Servers/<id>/Server/Commands.dat) ----------------------------
// Space-separated `Command value` lines with `//` comments, values never
// quoted; command names are case-insensitive.

export const UNTURNED_SETTINGS_CATEGORIES = ['Server & Network', 'World & Rules'] as const

export const UNTURNED_KEY_SPECS: GameKeySpecs = {
  Name: { kind: 'string', category: 'Server & Network', label: 'Server name' },
  Password: { kind: 'string', category: 'Server & Network', label: 'Join password' },
  MaxPlayers: { kind: 'int', category: 'Server & Network', label: 'Max players' },
  Port: { kind: 'int', category: 'Server & Network', managed: true, label: 'Game port (panel-managed)' },
  Owner: { kind: 'string', category: 'Server & Network', label: 'Owner SteamID64' },
  Welcome: { kind: 'string', category: 'Server & Network', label: 'Welcome message' },

  Map: { kind: 'string', category: 'World & Rules', label: 'Map' },
  Perspective: {
    kind: 'enum',
    category: 'World & Rules',
    enumValues: ['First', 'Third', 'Both', 'Vehicle'],
    label: 'Perspective',
  },
  Mode: { kind: 'enum', category: 'World & Rules', enumValues: ['Easy', 'Normal', 'Hard'], label: 'Difficulty mode' },
  Cycle: { kind: 'int', category: 'World & Rules', label: 'Day length (s)' },
}

// A settings PATCH: known keys are typed values, everything else may be
// passed as a raw string (kept verbatim in the tuple).
export const settingValueSchema = z.union([z.string(), z.number(), z.boolean()])
export type SettingValue = z.infer<typeof settingValueSchema>

export const settingsPatchSchema = z.object({
  values: z.record(settingValueSchema),
})
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

// GET /api/settings response — every tuple key with its raw token plus,
// for known keys, the coerced value.
export const settingsEntrySchema = z.object({
  key: z.string(),
  raw: z.string(),
  value: settingValueSchema.nullable(),
  kind: z.enum(['bool', 'int', 'float', 'string', 'enum']).nullable(),
  enumValues: z.array(z.string()).nullable(),
  managed: z.boolean(),
  label: z.string().nullable(),
  // Display section for the structured form (null → "Other" bucket). The
  // server emits it from the game's spec table so the web UI stays
  // game-agnostic.
  category: z.string().nullable(),
})
export type SettingsEntry = z.infer<typeof settingsEntrySchema>

export const settingsResponseSchema = z.object({
  entries: z.array(settingsEntrySchema),
  // The game's section render order for the structured form.
  categories: z.array(z.string()),
  pendingRestart: z.boolean(),
})
export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const rawSettingsSchema = z.object({
  // Entire PalWorldSettings.ini contents for the raw editor.
  content: z.string().max(1_000_000),
})
export type RawSettings = z.infer<typeof rawSettingsSchema>
