import { z } from 'zod'

// PalWorldSettings.ini contract. The file is a single
// `[/Script/Pal.PalGameWorldSettings]` section whose `OptionSettings=(K=V,…)`
// tuple holds every gameplay/server key. The server-side parser
// (apps/server settings-ini service) preserves unknown keys verbatim;
// this module types the keys we render as a structured form.

// Value kinds we know how to render + coerce. `string` values are
// double-quoted in the tuple; bools serialize as True/False.
export type PalKeyKind = 'bool' | 'int' | 'float' | 'string' | 'enum'

export interface PalKeySpec {
  kind: PalKeyKind
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
  // Identity / access
  ServerName: { kind: 'string', label: 'Server name' },
  ServerDescription: { kind: 'string', label: 'Server description' },
  ServerPassword: { kind: 'string', label: 'Join password' },
  AdminPassword: { kind: 'string', managed: true, label: 'Admin password (panel-managed)' },
  PublicIP: { kind: 'string', label: 'Public IP' },
  PublicPort: { kind: 'int', label: 'Public port' },
  ServerPlayerMaxNum: { kind: 'int', label: 'Max players' },
  CoopPlayerMaxNum: { kind: 'int', label: 'Co-op max players' },
  Region: { kind: 'string', label: 'Region' },
  bUseAuth: { kind: 'bool', label: 'Use auth' },
  BanListURL: { kind: 'string', label: 'Ban list URL' },
  AllowConnectPlatform: { kind: 'string', label: 'Allowed platform' },
  bShowPlayerList: { kind: 'bool', label: 'Show player list' },
  LogFormatType: { kind: 'string', label: 'Log format' },

  // Panel control channel
  RESTAPIEnabled: { kind: 'bool', managed: true, label: 'REST API (panel-managed)' },
  RESTAPIPort: { kind: 'int', managed: true, label: 'REST API port (panel-managed)' },
  RCONEnabled: { kind: 'bool', managed: true, label: 'RCON (panel-managed, off)' },
  RCONPort: { kind: 'int', label: 'RCON port' },

  // Difficulty / rates
  Difficulty: { kind: 'enum', enumValues: ['None', 'Normal', 'Difficult'], label: 'Difficulty' },
  RandomizerType: { kind: 'enum', enumValues: ['None', 'Region', 'All'], label: 'Randomizer' },
  RandomizerSeed: { kind: 'string', label: 'Randomizer seed' },
  bIsRandomizerPalLevelRandom: { kind: 'bool', label: 'Randomize Pal levels' },
  ItemWeightRate: { kind: 'float', label: 'Item weight' },
  AutoSaveSpan: { kind: 'float', label: 'Auto-save interval (s)' },
  DayTimeSpeedRate: { kind: 'float', label: 'Day speed' },
  NightTimeSpeedRate: { kind: 'float', label: 'Night speed' },
  ExpRate: { kind: 'float', label: 'XP rate' },
  PalCaptureRate: { kind: 'float', label: 'Pal capture rate' },
  PalSpawnNumRate: { kind: 'float', label: 'Pal spawn rate' },
  PalDamageRateAttack: { kind: 'float', label: 'Pal damage dealt' },
  PalDamageRateDefense: { kind: 'float', label: 'Pal damage taken' },
  PlayerDamageRateAttack: { kind: 'float', label: 'Player damage dealt' },
  PlayerDamageRateDefense: { kind: 'float', label: 'Player damage taken' },
  PlayerStomachDecreaceRate: { kind: 'float', label: 'Player hunger drain' },
  PlayerStaminaDecreaceRate: { kind: 'float', label: 'Player stamina drain' },
  PlayerAutoHPRegeneRate: { kind: 'float', label: 'Player HP regen' },
  PlayerAutoHpRegeneRateInSleep: { kind: 'float', label: 'Player HP regen (sleep)' },
  PalStomachDecreaceRate: { kind: 'float', label: 'Pal hunger drain' },
  PalStaminaDecreaceRate: { kind: 'float', label: 'Pal stamina drain' },
  PalAutoHPRegeneRate: { kind: 'float', label: 'Pal HP regen' },
  PalAutoHpRegeneRateInSleep: { kind: 'float', label: 'Pal HP regen (sleep)' },
  WorkSpeedRate: { kind: 'float', label: 'Work speed' },
  SupplyDropSpan: { kind: 'int', label: 'Supply drop interval (min)' },

  // Building / world
  BuildObjectHpRate: { kind: 'float', label: 'Structure HP' },
  BuildObjectDamageRate: { kind: 'float', label: 'Structure damage' },
  BuildObjectDeteriorationDamageRate: { kind: 'float', label: 'Structure decay' },
  CollectionDropRate: { kind: 'float', label: 'Gather drop rate' },
  CollectionObjectHpRate: { kind: 'float', label: 'Gather node HP' },
  CollectionObjectRespawnSpeedRate: { kind: 'float', label: 'Gather respawn speed' },
  EnemyDropItemRate: { kind: 'float', label: 'Enemy drop rate' },
  DropItemMaxNum: { kind: 'int', label: 'Max dropped items' },
  DropItemMaxNum_UNKO: { kind: 'int', label: 'Max dropped UNKO' },
  DropItemAliveMaxHours: { kind: 'float', label: 'Dropped item lifetime (h)' },
  BaseCampMaxNum: { kind: 'int', label: 'Max base camps' },
  BaseCampWorkerMaxNum: { kind: 'int', label: 'Max base workers' },
  PalEggDefaultHatchingTime: { kind: 'float', label: 'Egg hatch time (h)' },

  // Rules / PvP
  DeathPenalty: {
    kind: 'enum',
    enumValues: ['None', 'Item', 'ItemAndEquipment', 'All'],
    label: 'Death penalty',
  },
  bEnablePlayerToPlayerDamage: { kind: 'bool', label: 'PvP damage' },
  bEnableFriendlyFire: { kind: 'bool', label: 'Friendly fire' },
  bEnableInvaderEnemy: { kind: 'bool', label: 'Raids' },
  bActiveUNKO: { kind: 'bool', label: 'UNKO' },
  bEnableAimAssistPad: { kind: 'bool', label: 'Aim assist (pad)' },
  bEnableAimAssistKeyboard: { kind: 'bool', label: 'Aim assist (kb)' },
  bIsMultiplay: { kind: 'bool', label: 'Multiplayer' },
  bIsPvP: { kind: 'bool', label: 'PvP mode' },
  bCanPickupOtherGuildDeathPenaltyDrop: { kind: 'bool', label: 'Loot other guild drops' },
  bEnableNonLoginPenalty: { kind: 'bool', label: 'Non-login penalty' },
  bEnableFastTravel: { kind: 'bool', label: 'Fast travel' },
  bIsStartLocationSelectByMap: { kind: 'bool', label: 'Map start select' },
  bExistPlayerAfterLogout: { kind: 'bool', label: 'Body persists on logout' },
  bEnableDefenseOtherGuildPlayer: { kind: 'bool', label: 'Defend vs other guilds' },
  bIsUseBackupSaveData: { kind: 'bool', label: 'Game-native save backup' },
  bHardcore: { kind: 'bool', label: 'Hardcore mode' },
  bPalLost: { kind: 'bool', label: 'Pals lost on death' },
  bCharacterRecreateInHardcore: { kind: 'bool', label: 'Hardcore char recreate' },
  bInvisibleOtherGuildBaseCampAreaFX: { kind: 'bool', label: 'Hide other-guild base FX' },
  bBuildAreaLimit: { kind: 'bool', label: 'Limit build area' },
  ChatPostLimitPerMinute: { kind: 'int', label: 'Chat msgs/min limit' },

  // Guilds
  GuildPlayerMaxNum: { kind: 'int', label: 'Max guild members' },
  BaseCampMaxNumInGuild: { kind: 'int', label: 'Max bases per guild' },
  bAutoResetGuildNoOnlinePlayers: { kind: 'bool', label: 'Auto-reset idle guilds' },
  AutoResetGuildTimeNoOnlinePlayers: { kind: 'float', label: 'Idle guild reset (h)' },
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
