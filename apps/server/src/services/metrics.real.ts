import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ERROR_PATTERNS,
  compileErrorMatcher,
  effectiveResources,
  parseSystemdBytes,
  type GameDef,
  type MetricsErrorLine,
  type MetricsSample,
  type MetricsSnapshot,
  type ResourceOverrides,
} from '@rallypoint-cmd/shared'
import type { Logger } from '../logger.js'
import type { GameQuery, Journal, MetricsSampler } from './types.js'
import { SYSTEMCTL_BIN, assertAllowedUnit } from './constants.js'

const execFileAsync = promisify(execFile)

// Per-instance resource sampler. Reads the unit's cgroup v2 files every
// few seconds and keeps a rolling in-memory window, so the Monitoring
// page can show the run-up to a problem instead of a single instant.
//
// Everything here is UNPRIVILEGED: cgroup files under /sys/fs/cgroup are
// world-readable, `systemctl show` is a plain D-Bus read, and the
// latency probe is the same UDP query the dashboard already makes. No
// new sudoers lines — deploy/sudoers/rallypoint-cmd is untouched.

const SAMPLE_INTERVAL_MS = 5_000
// ~2h of history at the sample interval. A stopped server contributes no
// samples, so the window covers 2h of *uptime*, not 2h of wall clock.
const HISTORY_MAX = 1_440
const ERRORS_MAX = 100
const HOUR_MS = 3_600_000
const CGROUP_ROOT = '/sys/fs/cgroup'

export interface MetricsTarget {
  unitName: string
  game: GameDef
  query: GameQuery
  journal: Journal
  // Live per-server resource overrides (panel-edited); read fresh per
  // snapshot so a saved change moves the ceilings without a restart.
  getOverrides?: () => ResourceOverrides
}

// Parse a cgroup v2 flat-keyed file ("usage_usec 123\nnr_throttled 4\n")
// into numbers. Exported for tests.
export function parseKeyedStat(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (!key || value === undefined) continue
    const n = Number(value)
    if (Number.isFinite(n)) out.set(key, n)
  }
  return out
}

// Pull `some avg10=N` out of a PSI file. Returns null when the file is
// absent or malformed — PSI can be compiled out of the kernel, which is
// a missing metric, not an error. Exported for tests.
export function parsePsiAvg10(text: string): number | null {
  const m = /^some\s+.*?avg10=(\d+(?:\.\d+)?)/m.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// CPU percentage of total host capacity between two cgroup readings.
// Returns null when there is no usable previous reading (first sample,
// or the counter reset because the unit restarted). Exported for tests.
export function cpuPercent(
  prev: { usageUsec: number; atMs: number } | null,
  curr: { usageUsec: number; atMs: number },
  cpuCount: number,
): number | null {
  if (!prev) return null
  const wallUsec = (curr.atMs - prev.atMs) * 1000
  const usedUsec = curr.usageUsec - prev.usageUsec
  // A negative delta means the cgroup was recreated (unit restarted)
  // between ticks: the old baseline is meaningless, not a 0% sample.
  if (wallUsec <= 0 || usedUsec < 0 || cpuCount <= 0) return null
  return Math.min(100, (usedUsec / (wallUsec * cpuCount)) * 100)
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export function createRealMetricsSampler(logger: Logger, target: MetricsTarget): MetricsSampler {
  assertAllowedUnit(target.unitName)
  const { unitName, game, query, journal } = target

  const history: MetricsSample[] = []
  const errors: MetricsErrorLine[] = []
  const matcher = compileErrorMatcher(game.logPatterns?.error ?? DEFAULT_ERROR_PATTERNS)

  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let sampling = false
  let running = false
  let prevCpu: { usageUsec: number; atMs: number } | null = null
  let prevThrottled: { usec: number; atMs: number } | null = null
  // Resolved lazily from systemd and re-resolved whenever the directory
  // goes away, so a restart into a different cgroup path recovers on its
  // own without a per-tick subprocess in the steady state.
  let cgroupDir: string | null = null

  const hostCpus = Math.max(1, os.cpus().length)
  const hostMemBytes = os.totalmem()

  function currentLimits() {
    const effective = effectiveResources(game, target.getOverrides?.())
    return {
      memHighBytes: parseSystemdBytes(effective.memoryHigh ?? undefined),
      memMaxBytes: parseSystemdBytes(effective.memoryMax ?? undefined),
      cpuQuotaPct: effective.cpuQuotaPct,
      hostCpus,
      hostMemBytes,
    }
  }

  function recordError(line: string, ts: number): void {
    if (!matcher?.test(line)) return
    errors.push({ ts, line })
    if (errors.length > ERRORS_MAX) errors.shift()
  }

  // `systemctl show -p ControlGroup` gives the exact path systemd put the
  // unit in (e.g. /system.slice/system-rallypoint\x2dgame.slice/...),
  // which beats reconstructing the slice-escaping rules by hand. Empty
  // while the unit is down.
  async function resolveCgroupDir(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(SYSTEMCTL_BIN, ['show', unitName, '-p', 'ControlGroup'], {
        timeout: 10_000,
      })
      const value = stdout.split('=').slice(1).join('=').trim()
      if (!value || value === '/') return null
      return path.join(CGROUP_ROOT, value)
    } catch (err) {
      logger.warn('metrics: could not resolve control group', {
        unit: unitName,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  async function tick(): Promise<void> {
    if (sampling) return
    sampling = true
    try {
      if (!cgroupDir) cgroupDir = await resolveCgroupDir()
      const cpuStatRaw = cgroupDir ? await readMaybe(path.join(cgroupDir, 'cpu.stat')) : null
      if (cpuStatRaw === null) {
        // No cgroup: the unit is down (or moved). Drop the baselines so
        // the next start doesn't delta across the gap, and re-resolve the
        // path on the following tick.
        running = false
        prevCpu = null
        prevThrottled = null
        cgroupDir = null
        return
      }

      const now = Date.now()
      const [memRaw, cpuPsiRaw, memPsiRaw, reachProbe] = await Promise.all([
        readMaybe(path.join(cgroupDir!, 'memory.current')),
        readMaybe(path.join(cgroupDir!, 'cpu.pressure')),
        readMaybe(path.join(cgroupDir!, 'memory.pressure')),
        probeLatency(),
      ])

      const cpuStat = parseKeyedStat(cpuStatRaw)
      const usageUsec = cpuStat.get('usage_usec') ?? null
      const curr = usageUsec === null ? null : { usageUsec, atMs: now }
      const cpuPct = curr ? cpuPercent(prevCpu, curr, hostCpus) : null

      // throttled_usec only exists once a CPU quota is in play; without
      // one there is nothing to be throttled by, so null (unknown) is
      // right and 0 would be a claim we can't make.
      const throttledUsec = cpuStat.get('throttled_usec') ?? null
      let cpuThrottledPct: number | null = null
      if (throttledUsec !== null) {
        if (prevThrottled) {
          const wallUsec = (now - prevThrottled.atMs) * 1000
          const delta = throttledUsec - prevThrottled.usec
          if (wallUsec > 0 && delta >= 0) cpuThrottledPct = Math.min(100, (delta / wallUsec) * 100)
        }
        prevThrottled = { usec: throttledUsec, atMs: now }
      } else {
        prevThrottled = null
      }

      const memBytes = memRaw !== null && /^\d+$/.test(memRaw.trim()) ? Number(memRaw.trim()) : null

      prevCpu = curr
      running = true
      history.push({
        ts: now,
        cpuPct,
        cpuThrottledPct,
        cpuPressure: cpuPsiRaw === null ? null : parsePsiAvg10(cpuPsiRaw),
        memPressure: memPsiRaw === null ? null : parsePsiAvg10(memPsiRaw),
        memBytes: memBytes !== null && Number.isSafeInteger(memBytes) ? memBytes : null,
        latencyMs: reachProbe.latencyMs,
        reachable: reachProbe.reachable,
        load1: os.loadavg()[0] ?? null,
      })
      if (history.length > HISTORY_MAX) history.shift()
    } catch (err) {
      logger.warn('metrics sample failed', { unit: unitName, err: err instanceof Error ? err.message : String(err) })
    } finally {
      sampling = false
    }
  }

  // Time the game's own query round-trip — the closest thing to "how long
  // does this server take to answer a player". Games with no query
  // channel report unreachable with no latency rather than a fake zero.
  async function probeLatency(): Promise<{ latencyMs: number | null; reachable: boolean }> {
    if (game.capabilities.query === 'none') return { latencyMs: null, reachable: false }
    const started = performance.now()
    try {
      const ok = await query.reachable()
      return ok ? { latencyMs: Math.round(performance.now() - started), reachable: true } : { latencyMs: null, reachable: false }
    } catch {
      return { latencyMs: null, reachable: false }
    }
  }

  return {
    snapshot: (): MetricsSnapshot => {
      const cutoff = Date.now() - HOUR_MS
      return {
        running,
        limits: currentLimits(),
        current: history.length > 0 ? history[history.length - 1]! : null,
        history: [...history],
        errors: {
          recent: [...errors],
          lastHourCount: errors.reduce((n, e) => (e.ts >= cutoff ? n + 1 : n), 0),
        },
      }
    },
    start: () => {
      if (timer) return
      // Seed from whatever the journal tailer already holds so a freshly
      // started panel isn't blind to the errors that are already on
      // screen in the console view.
      const seenAt = Date.now()
      for (const line of journal.buffer()) recordError(line, seenAt)
      unsubscribe = journal.subscribe((line) => recordError(line, Date.now()))
      void tick()
      timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
      // Never hold the process open for a metrics tick.
      timer.unref()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
