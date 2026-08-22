import { z } from 'zod'

// Resource telemetry for one game server. The panel samples the unit's
// cgroup every few seconds and keeps a short in-memory history, so the
// UI can show *what led up to* a problem rather than only the instant
// it is asked. Nothing here is persisted: a panel restart starts a fresh
// window, which is the accepted trade for having no metrics table.
//
// Motivating case: Enshrouded logs "server overloaded" when its tick
// starves. That is a CPU/throttling story, and until now the panel
// measured only MemoryCurrent — so the one number it had was the one
// that looked fine.

// One sample. Every field is nullable because each source can be
// legitimately unavailable: the first tick has no previous counter to
// delta against, PSI is absent on kernels built without it, and a
// stopped unit has no cgroup at all.
export const metricsSampleSchema = z.object({
  ts: z.number().int().nonnegative(),
  // Percent of the host's TOTAL CPU capacity: 100 means every core
  // saturated, so it reads directly against `hostCpus`. Null on the
  // first sample after a (re)start — a delta needs two readings.
  cpuPct: z.number().nonnegative().nullable(),
  // Percent of the interval the cgroup spent throttled by its CPU quota.
  // Non-zero means the limit — not the workload — is the bottleneck.
  cpuThrottledPct: z.number().nonnegative().nullable(),
  // PSI `some avg10`: percent of the last 10s at least one task stalled
  // waiting for that resource. The most direct "is this overloaded"
  // number the kernel offers.
  cpuPressure: z.number().nonnegative().nullable(),
  memPressure: z.number().nonnegative().nullable(),
  memBytes: z.number().int().nonnegative().nullable(),
  // Round-trip of the game's own query probe. Null when the probe did
  // not answer — that is the signal, so it is kept distinct from 0.
  latencyMs: z.number().nonnegative().nullable(),
  reachable: z.boolean(),
  // Host-wide 1-minute load average: distinguishes "this game is busy"
  // from "the whole box is busy".
  load1: z.number().nonnegative().nullable(),
})
export type MetricsSample = z.infer<typeof metricsSampleSchema>

// A journal line that matched the game's error patterns, kept with the
// time the panel saw it (journald's own timestamp is not in the tailed
// output — `-o cat` strips it).
export const metricsErrorLineSchema = z.object({
  ts: z.number().int().nonnegative(),
  line: z.string(),
})
export type MetricsErrorLine = z.infer<typeof metricsErrorLineSchema>

// Ceilings the samples should be read against. memHigh/memMax come from
// the registry entry's systemd limits, so the UI can say "9.8G of 12G"
// instead of an unanchored byte count.
export const metricsLimitsSchema = z.object({
  memHighBytes: z.number().int().nonnegative().nullable(),
  memMaxBytes: z.number().int().nonnegative().nullable(),
  hostCpus: z.number().int().positive(),
  hostMemBytes: z.number().int().nonnegative(),
})
export type MetricsLimits = z.infer<typeof metricsLimitsSchema>

export const metricsSnapshotSchema = z.object({
  // The unit had a live cgroup at the last tick.
  running: z.boolean(),
  limits: metricsLimitsSchema,
  // Most recent sample; null when nothing has been sampled yet (panel
  // just started, or the server has been down the whole window).
  current: metricsSampleSchema.nullable(),
  // Oldest → newest. Gaps (a stopped server) show up as jumps in `ts`
  // rather than as filler samples.
  history: z.array(metricsSampleSchema),
  errors: z.object({
    recent: z.array(metricsErrorLineSchema),
    lastHourCount: z.number().int().nonnegative(),
  }),
})
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>

// Error patterns applied to a game's console lines when the registry
// entry doesn't name its own. Deliberately broad — a panel that shows
// too many lines is a nuisance; one that hides the line explaining a
// crash is useless.
export const DEFAULT_ERROR_PATTERNS: readonly string[] = [
  'overload',
  '\\berrors?\\b',
  '\\bwarn(ing)?\\b',
  '\\bfail(ed|ure)?\\b',
  '\\bexception\\b',
  '\\bfatal\\b',
]

// Compile a game's patterns into one case-insensitive matcher. Invalid
// patterns are dropped rather than thrown: a bad registry regex must not
// take the whole sampler down. Returns null when nothing compiles, which
// callers read as "match nothing".
export function compileErrorMatcher(patterns: readonly string[]): RegExp | null {
  const usable = patterns.filter((p) => {
    try {
      new RegExp(p)
      return true
    } catch {
      return false
    }
  })
  if (usable.length === 0) return null
  return new RegExp(usable.map((p) => `(?:${p})`).join('|'), 'i')
}

// Parse a systemd byte quantity ("12G", "512M", "1.5G", "infinity") into
// bytes. systemd uses power-of-two suffixes. Returns null for
// `infinity`, an empty value, or anything unparseable — all of which
// mean "no ceiling to draw".
const SYSTEMD_BYTE_SUFFIXES: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

export function parseSystemdBytes(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)$/i.exec(value.trim())
  if (!m) return null
  const scale = SYSTEMD_BYTE_SUFFIXES[m[2]!.toUpperCase()]
  if (scale === undefined) return null
  return Math.round(Number(m[1]) * scale)
}
