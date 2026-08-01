import {
  backupsResponseSchema,
  errorEnvelopeSchema,
  longOpSchema,
  panelUpdateInfoSchema,
  playersResponseSchema,
  restorePreviewSchema,
  scheduleSchema,
  schedulesResponseSchema,
  scheduleRunsResponseSchema,
  serverStatusSchema,
  sessionInfoSchema,
  settingsResponseSchema,
  updateStateSchema,
  type Backup,
  type CreateScheduleRequest,
  type LongOp,
  type PanelUpdateInfo,
  type PlayersResponse,
  type RestorePreview,
  type Schedule,
  type ScheduleRun,
  type ServerStatus,
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
  status: (): Promise<ServerStatus> => request('GET', '/api/status', serverStatusSchema),
  power: (action: 'start' | 'stop' | 'restart'): Promise<unknown> =>
    request('POST', '/api/power', okSchema, { action }),

  // players
  players: (): Promise<PlayersResponse> => request('GET', '/api/players', playersResponseSchema),
  announce: (message: string): Promise<unknown> =>
    request('POST', '/api/players/announce', okSchema, { message }),
  kick: (userId: string, message?: string): Promise<unknown> =>
    request('POST', '/api/players/kick', okSchema, { userId, message }),
  ban: (userId: string, message?: string): Promise<unknown> =>
    request('POST', '/api/players/ban', okSchema, { userId, message }),
  unban: (userId: string): Promise<unknown> =>
    request('POST', '/api/players/unban', okSchema, { userId }),
  save: (): Promise<unknown> => request('POST', '/api/save', okSchema),

  // settings
  settings: (): Promise<SettingsResponse> => request('GET', '/api/settings', settingsResponseSchema),
  updateSettings: (values: Record<string, SettingValue>): Promise<unknown> =>
    request('PUT', '/api/settings', okSchema, { values }),
  rawSettings: (): Promise<{ content: string }> =>
    request('GET', '/api/settings/raw', z.object({ content: z.string() })),
  updateRawSettings: (content: string): Promise<unknown> =>
    request('PUT', '/api/settings/raw', okSchema, { content }),

  // updates / steamcmd
  updateState: (): Promise<UpdateState> => request('GET', '/api/updates', updateStateSchema),
  runUpdate: (kind: 'install' | 'update' | 'validate'): Promise<LongOp> =>
    request('POST', '/api/updates/run', longOpSchema, { kind }),

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
    request('GET', '/api/backups', backupsResponseSchema),
  createBackup: (): Promise<LongOp> => request('POST', '/api/backups', longOpSchema),
  deleteBackup: (id: string): Promise<unknown> =>
    request('DELETE', `/api/backups/${id}`, okSchema),
  uploadBackup: async (file: File): Promise<RestorePreview> => {
    const csrf = await ensureCsrf()
    const res = await fetch('/api/backups/upload', {
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
    request('POST', '/api/backups/restore', longOpSchema, { stagingId, confirm }),
  downloadBackupUrl: (id: string): string => `/api/backups/${id}/download`,

  // schedules
  schedules: (): Promise<{ schedules: Schedule[] }> =>
    request('GET', '/api/schedules', schedulesResponseSchema),
  createSchedule: (req: CreateScheduleRequest): Promise<Schedule> =>
    request('POST', '/api/schedules', scheduleSchema, req),
  updateSchedule: (id: string, req: UpdateScheduleRequest): Promise<Schedule> =>
    request('PATCH', `/api/schedules/${id}`, scheduleSchema, req),
  deleteSchedule: (id: string): Promise<unknown> =>
    request('DELETE', `/api/schedules/${id}`, okSchema),
  scheduleRuns: (id: string): Promise<{ runs: ScheduleRun[] }> =>
    request('GET', `/api/schedules/${id}/runs`, scheduleRunsResponseSchema),
}
