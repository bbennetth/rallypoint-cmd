export * from './api.js'
export * from './backups.js'
export * from './games.js'
export * from './management.js'
export * from './metrics.js'
export * from './mods.js'
export * from './schedules.js'
export * from './server-status.js'
export * from './servers.js'
export * from './settings.js'

// Palworld dedicated server's Steam app id (steamcmd +app_update target).
export const PALWORLD_APP_ID = 2394010

// Session bearer prefix for the panel's own opaque tokens (rallypoint
// convention: prefixed random tokens, sha256 at rest).
export const PANEL_TOKEN_PREFIXES = {
  session: 'pws_live_',
} as const
