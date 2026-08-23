import type { MetricsSample, MetricsSnapshot } from '@rallypoint-cmd/shared'
import { api } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { useCurrentGame } from '../lib/useCurrentGame.js'
import { formatBytes } from '../lib/format.js'
import { Badge, Card, Spinner, Stat } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { ProgressBar } from '../ui/ProgressBar.js'
import { LogPane } from '../ui/LogPane.js'
import { Sparkline, type SparklineTone } from '../ui/Sparkline.js'

// Resource telemetry for one server. The question this page exists to
// answer is "the game said it was overloaded — what was actually
// happening?", so every panel is chosen to separate the plausible
// causes: the game is working too hard (CPU), it is being held back by
// its own limit (throttling), it is starved of memory, the whole host is
// busy (load), or it has simply stopped answering (latency).
//
// Polls the snapshot endpoint; the server samples on its own timer, so
// the poll interval controls only how fresh the page is, not how often
// anything is measured.

const POLL_MS = 5000
// Percentages of the memory ceiling at which the bar changes character.
// MemoryHigh is where the kernel starts reclaiming hard, so approaching
// it is the interesting event, not reaching MemoryMax.
const MEM_WARN_PCT = 85

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`
}

function ms(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)} ms`
}

// Worst-case reading over the window, used for the "peak" captions —
// an average hides exactly the spikes this page is looking for.
function peakOf(history: readonly MetricsSample[], key: keyof MetricsSample): number | null {
  let best: number | null = null
  for (const s of history) {
    const v = s[key]
    if (typeof v === 'number' && (best === null || v > best)) best = v
  }
  return best
}

export function MonitoringPage() {
  const { data, error } = usePoll(api.metrics, POLL_MS)
  const game = useCurrentGame()

  if (error && !data) return <Banner tone="bad">Could not load metrics: {error.message}</Banner>
  if (!data)
    return (
      <div className="cmd-empty flex items-center gap-2">
        <Spinner /> Loading metrics…
      </div>
    )

  const { current, history, limits, errors, running } = data
  const hasQuery = game ? game.capabilities.query !== 'none' : true

  // Memory is read against MemoryHigh (the reclaim threshold) when the
  // registry declares one — an unanchored byte count can't tell you
  // whether 9 GiB is comfortable or nearly fatal.
  const memCeiling = limits.memHighBytes ?? limits.memMaxBytes ?? limits.hostMemBytes
  const memPct = current?.memBytes != null && memCeiling > 0 ? (current.memBytes / memCeiling) * 100 : null

  const cpuPeak = peakOf(history, 'cpuPct')
  const latencyPeak = peakOf(history, 'latencyMs')
  const throttlePeak = peakOf(history, 'cpuThrottledPct')

  return (
    <div className="space-y-6">
      <div className="pg-head">
        <h1>Monitoring</h1>
      </div>

      {!running && (
        <Banner>Server is stopped — sampling resumes when it starts. History below is from its last run.</Banner>
      )}

      {running && throttlePeak !== null && throttlePeak > 1 && (
        <Banner tone="warn">
          CPU was throttled by its own limit (peak {pct(throttlePeak)} of an interval) during this window — the
          server is hitting a configured ceiling, not just a busy host.
        </Banner>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="CPU"
          value={pct(current?.cpuPct)}
          sub={`peak ${pct(cpuPeak)} of ${limits.hostCpus} cores`}
        />
        <Stat
          label="Memory"
          value={formatBytes(current?.memBytes)}
          sub={memCeiling > 0 ? `of ${formatBytes(memCeiling)} limit` : undefined}
        />
        <Stat
          label="Latency"
          value={hasQuery ? ms(current?.latencyMs) : 'n/a'}
          sub={
            hasQuery ? (
              <Badge tone={current?.reachable ? 'good' : running ? 'bad' : 'muted'}>
                {current?.reachable ? 'answering' : running ? 'no answer' : 'offline'}
              </Badge>
            ) : (
              'no query port'
            )
          }
        />
        <Stat
          label="Errors (1h)"
          value={errors.lastHourCount}
          sub={errors.lastHourCount > 0 ? 'see log below' : 'none logged'}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Chart
          title="CPU"
          history={history}
          pick={(s) => s.cpuPct}
          max={100}
          tone={(current?.cpuPct ?? 0) > 85 ? 'bad' : (current?.cpuPct ?? 0) > 60 ? 'warn' : 'accent'}
          value={pct(current?.cpuPct)}
          right={`${limits.hostCpus} cores · load ${current?.load1?.toFixed(2) ?? '—'}`}
        />

        <Card title="Memory">
          <div className="space-y-3">
            <div className="cmd-spark-head">
              <span className="display cmd-stat-value">{formatBytes(current?.memBytes)}</span>
              <span className="meta">of {formatBytes(memCeiling)}</span>
            </div>
            <Sparkline
              points={history.map((s) => s.memBytes)}
              max={memCeiling > 0 ? memCeiling : undefined}
              tone={memPct != null && memPct > MEM_WARN_PCT ? 'warn' : 'accent'}
              label="Memory use over time"
            />
            {memPct != null && (
              <ProgressBar
                value={memPct}
                tone={memPct >= 100 ? 'bad' : memPct > MEM_WARN_PCT ? 'warn' : 'accent'}
                size="sm"
                right={`${Math.round(memPct)}% of limit`}
              />
            )}
          </div>
        </Card>

        {hasQuery && (
          <Chart
            title="Query latency"
            history={history}
            pick={(s) => s.latencyMs}
            tone={(current?.latencyMs ?? 0) > 150 ? 'warn' : 'accent'}
            value={ms(current?.latencyMs)}
            right={`peak ${ms(latencyPeak)}`}
          />
        )}

        <Chart
          title="CPU pressure"
          history={history}
          pick={(s) => s.cpuPressure}
          max={100}
          tone={(current?.cpuPressure ?? 0) > 40 ? 'bad' : 'accent'}
          value={pct(current?.cpuPressure)}
          right="time stalled on CPU"
          note="Percent of the last 10s in which work was waiting on CPU. Sustained values here are what a game reports as an overload."
        />
      </div>

      <Card title={`Recent errors${errors.recent.length > 0 ? ` (${errors.recent.length})` : ''}`}>
        <LogPane
          lines={errors.recent.map((e) => `${new Date(e.ts).toLocaleTimeString()}  ${e.line}`)}
          empty="No error or warning lines matched in the console buffer."
          maxHeight={260}
          errorPattern={/overload|error|fail|fatal/i}
        />
      </Card>
    </div>
  )
}

function Chart({
  title,
  history,
  pick,
  max,
  tone,
  value,
  right,
  note,
}: {
  title: string
  history: readonly MetricsSnapshot['history'][number][]
  pick: (s: MetricsSample) => number | null
  max?: number | undefined
  tone: SparklineTone
  value: string
  right: string
  note?: string | undefined
}) {
  return (
    <Card title={title}>
      <div className="cmd-spark-head">
        <span className="display cmd-stat-value">{value}</span>
        <span className="meta">{right}</span>
      </div>
      <Sparkline points={history.map(pick)} max={max} tone={tone} label={`${title} over time`} />
      {note && <p className="cmd-note mt-3">{note}</p>}
    </Card>
  )
}
