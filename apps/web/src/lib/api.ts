import {
  backupsResponseSchema,
  errorEnvelopeSchema,
  longOpSchema,
  modsResponseSchema,
  modUploadResultSchema,
  panelUpdateInfoSchema,
  playersResponseSchema,
  publicAccessConsoleSchema,
  publicAccessStatusSchema,
  restorePreviewSchema,
  scheduleSchema,
  schedulesResponseSchema,
  scheduleRunsResponseSchema,
  serverStatusSchema,
  serversResponseSchema,
  gameServerSchema,
  sessionInfoSchema,
  settingsResponseSchema,
  updateStateSchema,
  type Backup,
  type CreateScheduleRequest,
  type LongOp,
  type ModsResponse,
  type ModUploadResult,
  type PanelUpdateInfo,
  type PlayersResponse,
  type PublicAccessConsole,
  type PublicAccessStatus,
  type RestorePreview,
  type Schedule,
  type ScheduleRun,
  type ServerStatus,
  type ServersResponse,
  type GameServer,
  type SessionInfo,
  type SettingsResponse,
  type SettingValue,
  type UpdateScheduleRequest,
  type UpdateState,
} from '@rallypoint-cmd/shared'
import { z } from 'zod'

// Typed fetch client. Same-origin, cookie session; state-changing calls
// carry the double-submit CSRF header. Responses are parsed against the
// shared Zod schemas so the UI and server can't drift.
//
// Game-scoped endpoints are server-relative: inside /servers/:serverId/*
// routes they hit /api/servers/:serverId/..., elsewhere they fall back
// to the legacy /api/... alias (the default server). Deriving the scope
// from the URL at call time avoids any provider-ordering races.

export function apiScope(): string {
  const m = window.location.pathname.match(/^\/servers\/([a-z0-9-]+)/)
  return m ? `/api/servers/${m[1]}` : '/api'
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

let csrfToken: string | null = null

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const res = await fetch('/api/csrf', { credentials: 'same-origin' })
  const json = (await res.json()) as { token: string }
  csrfToken = json.token
  return csrfToken
}

// Infer the return type from the schema's OUTPUT (post-parse) — not its
// input — so schemas that apply Zod defaults still yield the fully-required
// domain type (e.g. Schedule) to callers.
async function request<S extends z.ZodTypeAny>(
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-csrf-token'] = await ensureCsrf()

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (!res.ok) {
    let code = 'error'
    let message = res.statusText
    let details: Record<string, unknown> | undefined
    try {
      const parsed = errorEnvelopeSchema.parse(await res.json())
      code = parsed.error.code
      message = parsed.error.message
      details = parsed.error.details
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(code, message, res.status, details)
  }
  if (res.status === 204) return schema.parse(undefined) as z.output<S>
  return schema.parse(await res.json()) as z.output<S>
}

const okSchema = z.object({ ok: z.literal(true) }).passthrough()

export const api = {
  // auth
  login: (username: string, password: string): Promise<SessionInfo> =>
    request('POST', '/api/auth/login', sessionInfoSchema, { username, password }),
  session: (): Promise<SessionInfo> => request('GET', '/api/auth/session', sessionInfoSchema),
  logout: (): Promise<unknown> => request('POST', '/api/auth/logout', okSchema),
  changePassword: (currentPassword: string, newPassword: string): Promise<unknown> =>
    request('POST', '/api/auth/change-password', okSchema, { currentPassword, newPassword }),

  // status + power
  status: (): Promise<ServerStatus> => request('GET', `${apiScope()}/status`, serverStatusSchema),
  power: (action: 'start' | 'stop' | 'restart'): Promise<unknown> =>
    request('POST', `${apiScope()}/power`, okSchema, { action }),

  // players
  players: (): Promise<PlayersResponse> => request('GET', `${apiScope()}/players`, playersResponseSchema),
  announce: (message: string): Promise<unknown> =>
    request('POST', `${apiScope()}/players/announce`, okSchema, { message }),
  kick: (userId: string, message?: string): Promise<unknown> =>
    request('POST', `${apiScope()}/players/kick`, okSchema, { userId, message }),
  ban: (userId: string, message?: string): Promise<unknown> =>
    request('POST', `${apiScope()}/players/ban`, okSchema, { userId, message }),
  unban: (userId: string): Promise<unknown> =>
    request('POST', `${apiScope()}/players/unban`, okSchema, { userId }),
  save: (): Promise<unknown> => request('POST', `${apiScope()}/save`, okSchema),

  // settings
  settings: (): Promise<SettingsResponse> => request('GET', `${apiScope()}/settings`, settingsResponseSchema),
  updateSettings: (values: Record<string, SettingValue>): Promise<unknown> =>
    request('PUT', `${apiScope()}/settings`, okSchema, { values }),
  rawSettings: (): Promise<{ content: string }> =>
    request('GET', `${apiScope()}/settings/raw`, z.object({ content: z.string() })),
  updateRawSettings: (content: string): Promise<unknown> =>
    request('PUT', `${apiScope()}/settings/raw`, okSchema, { content }),

  // updates / steamcmd
  updateState: (): Promise<UpdateState> => request('GET', `${apiScope()}/updates`, updateStateSchema),
  runUpdate: (kind: 'install' | 'update' | 'validate'): Promise<LongOp> =>
    request('POST', `${apiScope()}/updates/run`, longOpSchema, { kind }),

  // public access (playit.gg)
  publicAccess: (): Promise<PublicAccessStatus> =>
    request('GET', '/api/public-access', publicAccessStatusSchema),
  enablePublicAccess: (): Promise<LongOp> =>
    request('POST', '/api/public-access/enable', longOpSchema),
  disablePublicAccess: (): Promise<unknown> =>
    request('POST', '/api/public-access/disable', okSchema),
  publicAccessConsole: (): Promise<PublicAccessConsole> =>
    request('GET', '/api/public-access/console', publicAccessConsoleSchema),

  // panel self-update
  panelUpdate: (force = false): Promise<PanelUpdateInfo> =>
    request('GET', `/api/panel/update${force ? '?force=1' : ''}`, panelUpdateInfoSchema),
  runPanelUpdate: (): Promise<LongOp> =>
    request('POST', '/api/panel/update/run', longOpSchema),
  health: (): Promise<{ ok: true; version: string; mode: string }> =>
    request(
      'GET',
      '/api/health',
      z.object({ ok: z.literal(true), version: z.string(), mode: z.string() }).passthrough(),
    ),

  // backups
  backups: (): Promise<{ backups: Backup[] }> =>
    request('GET', `${apiScope()}/backups`, backupsResponseSchema),
  createBackup: (): Promise<LongOp> => request('POST', `${apiScope()}/backups`, longOpSchema),
  deleteBackup: (id: string): Promise<unknown> =>
    request('DELETE', `${apiScope()}/backups/${id}`, okSchema),
  uploadBackup: async (file: File): Promise<RestorePreview> => {
    const csrf = await ensureCsrf()
    const res = await fetch(`${apiScope()}/backups/upload`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/gzip', 'x-csrf-token': csrf },
      body: file,
    })
    if (!res.ok) {
      const parsed = errorEnvelopeSchema.safeParse(await res.json().catch(() => null))
      throw new ApiError(
        parsed.success ? parsed.data.error.code : 'error',
        parsed.success ? parsed.data.error.message : res.statusText,
        res.status,
      )
    }
    return restorePreviewSchema.parse(await res.json())
  },
  restoreBackup: (stagingId: string, confirm: string): Promise<LongOp> =>
    request('POST', `${apiScope()}/backups/restore`, longOpSchema, { stagingId, confirm }),
  downloadBackupUrl: (id: string): string => `${apiScope()}/backups/${id}/download`,

  // mods
  mods: (): Promise<ModsResponse> => request('GET', `${apiScope()}/mods`, modsResponseSchema),
  uploadMod: async (file: File): Promise<ModUploadResult> => {
    const csrf = await ensureCsrf()
    const res = await fetch(`${apiScope()}/mods/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf },
      body: file,
    })
    if (!res.ok) {
      const parsed = errorEnvelopeSchema.safeParse(await res.json().catch(() => null))
      throw new ApiError(
        parsed.success ? parsed.data.error.code : 'error',
        parsed.success ? parsed.data.error.message : res.statusText,
        res.status,
      )
    }
    return modUploadResultSchema.parse(await res.json())
  },
  toggleMod: (id: string, enabled: boolean): Promise<ModsResponse> =>
    request('POST', `${apiScope()}/mods/${encodeURIComponent(id)}/toggle`, modsResponseSchema, { enabled }),
  deleteMod: (id: string): Promise<unknown> =>
    request('DELETE', `${apiScope()}/mods/${encodeURIComponent(id)}`, okSchema),

  // servers
  servers: (): Promise<ServersResponse> => request('GET', '/api/servers', serversResponseSchema),
  createServer: (gameSlug: string, name: string): Promise<GameServer> =>
    request('POST', '/api/servers', gameServerSchema, { gameSlug, name }),
  deleteServer: (id: string): Promise<unknown> =>
    request('DELETE', `/api/servers/${id}`, okSchema),

  // schedules
  schedules: (): Promise<{ schedules: Schedule[] }> =>
    request('GET', `${apiScope()}/schedules`, schedulesResponseSchema),
  createSchedule: (req: CreateScheduleRequest): Promise<Schedule> =>
    request('POST', `${apiScope()}/schedules`, scheduleSchema, req),
  updateSchedule: (id: string, req: UpdateScheduleRequest): Promise<Schedule> =>
    request('PATCH', `${apiScope()}/schedules/${id}`, scheduleSchema, req),
  deleteSchedule: (id: string): Promise<unknown> =>
    request('DELETE', `${apiScope()}/schedules/${id}`, okSchema),
  scheduleRuns: (id: string): Promise<{ runs: ScheduleRun[] }> =>
    request('GET', `${apiScope()}/schedules/${id}/runs`, scheduleRunsResponseSchema),
}
