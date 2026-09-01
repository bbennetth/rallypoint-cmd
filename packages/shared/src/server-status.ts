import { z } from 'zod'

// Merged server status — the panel's single source of truth for the
// dashboard. Combines systemd unit state, the Palworld REST API (only
// reachable while the game is up), the installed build, and disk usage.

// Lifecycle collapses systemd ActiveState plus an "is the game even
// installed" probe (PalServer.sh present on disk) into one enum the UI
// can render directly.
export const serverLifecycleSchema = z.enum([
  'not_installed',
  'inactive',
  'activating',
  'active',
  'deactivating',
  'failed',
])
export type ServerLifecycle = z.infer<typeof serverLifecycleSchema>

// Subset of `GET /v1/api/info` we surface. `.passthrough()` because
// Pocketpair adds fields across patches — never reject unknown keys.
export const palServerInfoSchema = z
  .object({
    version: z.string(),
    servername: z.string(),
    description: z.string().optional(),
    worldguid: z.string().optional(),
  })
  .passthrough()
export type PalServerInfo = z.infer<typeof palServerInfoSchema>

// Subset of `GET /v1/api/metrics`. Every field is optional because each
// query adapter answers a different slice: the REST API supplies all of
// them, an A2S query (Enshrouded) only the player counts, and
// Satisfactory's lightweight query none at all. The UI renders a
// missing field as `—`.
export const palServerMetricsSchema = z
  .object({
    serverfps: z.number().optional(),
    currentplayernum: z.number().optional(),
    serverframetime: z.number().optional(),
    maxplayernum: z.number().optional(),
    uptime: z.number().optional(),
    days: z.number().optional(),
  })
  .passthrough()
export type PalServerMetrics = z.infer<typeof palServerMetricsSchema>

export const diskUsageSchema = z.object({
  label: z.string(),
  mount: z.string(),
  totalBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
})
export type DiskUsage = z.infer<typeof diskUsageSchema>

export const serverStatusSchema = z.object({
  lifecycle: serverLifecycleSchema,
  // Set when the ini changed after the last (re)start — the running game
  // hasn't picked the edit up yet.
  pendingRestart: z.boolean(),
  // From steamapps/appmanifest_2394010.acf; null before first install.
  buildId: z.string().nullable(),
  world: z.object({
    // 32-hex dir under Pal/Saved/SaveGames/0/; null before first boot.
    id: z.string().nullable(),
    // Epoch ms of the newest file in the live save dir — when the game
    // last wrote a save. Null before the first save (or when unknown).
    lastSavedAtMs: z.number().int().nonnegative().nullable(),
  }),
  systemd: z.object({
    activeState: z.string(),
    subState: z.string(),
    memoryCurrentBytes: z.number().int().nonnegative().nullable(),
    // Epoch ms of the unit's last transition to active; null when down.
    activeEnterAtMs: z.number().int().nonnegative().nullable(),
  }),
  rest: z.object({
    reachable: z.boolean(),
    info: palServerInfoSchema.optional(),
    metrics: palServerMetricsSchema.optional(),
  }),
  disks: z.array(diskUsageSchema),
})
export type ServerStatus = z.infer<typeof serverStatusSchema>
