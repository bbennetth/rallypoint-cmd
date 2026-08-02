import { z } from 'zod'

// Request/response contract shared by the Hono server (validation) and
// the web client (parsing). Every route's body/response lives here so
// the two sides can never drift.

// ---------------------------------------------------------------------------
// Error envelope (mirrors rallypoint's error-shape: code + message + details)

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

export const okSchema = z.object({ ok: z.literal(true) })
export type Ok = z.infer<typeof okSchema>

// ---------------------------------------------------------------------------
// Auth

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const sessionInfoSchema = z.object({
  username: z.string(),
  // Epoch ms when this session hard-expires.
  expiresAtMs: z.number().int().nonnegative(),
})
export type SessionInfo = z.infer<typeof sessionInfoSchema>

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
})
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>

// ---------------------------------------------------------------------------
// Power control

export const powerActionSchema = z.enum(['start', 'stop', 'restart'])
export type PowerAction = z.infer<typeof powerActionSchema>

export const powerRequestSchema = z.object({ action: powerActionSchema })
export type PowerRequest = z.infer<typeof powerRequestSchema>

// ---------------------------------------------------------------------------
// Players (proxied Palworld REST API)

// Shape of one entry from `GET /v1/api/players`. Passthrough: Pocketpair
// extends this per patch.
export const playerSchema = z
  .object({
    name: z.string(),
    accountName: z.string().optional(),
    playerId: z.string(),
    userId: z.string(),
    ip: z.string().optional(),
    ping: z.number().optional(),
    location_x: z.number().optional(),
    location_y: z.number().optional(),
    level: z.number().optional(),
    building_count: z.number().optional(),
  })
  .passthrough()
export type Player = z.infer<typeof playerSchema>

export const playersResponseSchema = z.object({ players: z.array(playerSchema) })
export type PlayersResponse = z.infer<typeof playersResponseSchema>

export const announceRequestSchema = z.object({
  message: z.string().min(1).max(600),
})
export type AnnounceRequest = z.infer<typeof announceRequestSchema>

export const kickBanRequestSchema = z.object({
  // Palworld user id, e.g. `steam_xxxxx`.
  userId: z.string().min(1),
  message: z.string().max(600).optional(),
})
export type KickBanRequest = z.infer<typeof kickBanRequestSchema>

export const unbanRequestSchema = z.object({
  userId: z.string().min(1),
})
export type UnbanRequest = z.infer<typeof unbanRequestSchema>

// ---------------------------------------------------------------------------
// Long-running operations (steamcmd install/update, restore)

export const longOpKindSchema = z.enum(['install', 'update', 'validate', 'restore', 'backup', 'panel_update', 'public_access'])
export type LongOpKind = z.infer<typeof longOpKindSchema>

export const longOpStatusSchema = z.enum(['running', 'succeeded', 'failed'])
export type LongOpStatus = z.infer<typeof longOpStatusSchema>

export const longOpSchema = z.object({
  id: z.string(),
  kind: longOpKindSchema,
  status: longOpStatusSchema,
  startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative().nullable(),
  // 0..100 when the op reports progress (steamcmd), null otherwise.
  progressPct: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(),
})
export type LongOp = z.infer<typeof longOpSchema>

export const updateRunRequestSchema = z.object({
  kind: z.enum(['install', 'update', 'validate']),
})
export type UpdateRunRequest = z.infer<typeof updateRunRequestSchema>

export const updateStateSchema = z.object({
  // Currently- or last-run op; null before anything ever ran.
  op: longOpSchema.nullable(),
  installedBuildId: z.string().nullable(),
})
export type UpdateState = z.infer<typeof updateStateSchema>

// SSE event names used by /api/console/stream and /api/updates/stream.
// Console: `log` (one journal line per event) + `ping` heartbeats.
// Updates: `log`, `progress` (data = pct), `done` (data = LongOp JSON), `ping`.
export const SSE_EVENTS = {
  log: 'log',
  progress: 'progress',
  done: 'done',
  ping: 'ping',
} as const

// --- panel self-update (GitHub Releases) -----------------------------------

export const panelUpdateInfoSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  publishedAt: z.string().nullable(),
  notes: z.string().nullable(),
  // Epoch ms of the last successful GitHub check; null if never checked.
  checkedAtMs: z.number().int().nonnegative().nullable(),
})
export type PanelUpdateInfo = z.infer<typeof panelUpdateInfoSchema>

// --- public access (playit.gg) ---------------------------------------------

export const publicAccessStatusSchema = z.object({
  // playit agent installed in the CT
  installed: z.boolean(),
  // agent has a secret (claim completed)
  claimed: z.boolean(),
  // playit service currently active
  running: z.boolean(),
  // public address players connect to (host:port), when known
  address: z.string().nullable(),
  // set while an enable flow is waiting for the user to approve the claim
  pendingClaim: z.object({ code: z.string(), url: z.string() }).nullable(),
  // game port being exposed (from PalWorldSettings PublicPort)
  gamePort: z.number().int().nullable(),
})
export type PublicAccessStatus = z.infer<typeof publicAccessStatusSchema>

export const publicAccessConsoleSchema = z.object({
  // Panel-side record of helper invocations + api.playit.gg exchanges.
  trace: z.array(z.object({ ts: z.number().int(), kind: z.enum(['api', 'helper', 'agent']), line: z.string() })),
  // Recent playit agent journal lines (empty when not installed).
  agentLog: z.array(z.string()),
})
export type PublicAccessConsole = z.infer<typeof publicAccessConsoleSchema>
