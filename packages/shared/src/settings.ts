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
})
export type SettingsEntry = z.infer<typeof settingsEntrySchema>

export const settingsResponseSchema = z.object({
  entries: z.array(settingsEntrySchema),
  pendingRestart: z.boolean(),
})
export type SettingsResponse = z.infer<typeof settingsResponseSchema>

export const rawSettingsSchema = z.object({
  // Entire PalWorldSettings.ini contents for the raw editor.
  content: z.string().max(1_000_000),
})
export type RawSettings = z.infer<typeof rawSettingsSchema>
