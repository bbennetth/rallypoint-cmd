import { useEffect, useId, useState } from 'react'
import {
  memoryLimitSchema,
  type MetricsSample,
  type MetricsSnapshot,
  type ResourcesPatch,
  type ResourcesResponse,
} from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { useCurrentGame } from '../lib/useCurrentGame.js'
import { formatBytes } from '../lib/format.js'
import { Badge, Button, Card, inputClass, Spinner, Stat } from '../ui/primitives.js'
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
          right={`${limits.hostCpus} cores${limits.cpuQuotaPct != null ? ` · quota ${limits.cpuQuotaPct}%` : ''} · load ${current?.load1?.toFixed(2) ?? '—'}`}
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

      <ResourcesCard />

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

// Editable per-server resource limits, layered over the game's registry
// defaults. Empty field = use the default; a save rewrites the systemd
// drop-in and takes effect on the next restart.
function ResourcesCard() {
  const [data, setData] = useState<ResourcesResponse | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [memoryHigh, setMemoryHigh] = useState('')
  const [memoryMax, setMemoryMax] = useState('')
  const [cpuQuota, setCpuQuota] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function load() {
    try {
      const res = await api.resources()
      setData(res)
      setMemoryHigh(res.overrides.memoryHigh ?? '')
      setMemoryMax(res.overrides.memoryMax ?? '')
      setCpuQuota(res.overrides.cpuQuotaPct != null ? String(res.overrides.cpuQuotaPct) : '')
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : 'Failed to load resource limits')
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (loadErr) {
    return (
      <Card title="Resource limits">
        <Banner tone="bad">{loadErr}</Banner>
      </Card>
    )
  }
  if (!data) {
    return (
      <Card title="Resource limits">
        <p className="cmd-empty">Loading…</p>
      </Card>
    )
  }

  const maxQuota = data.host.cpus * 100
  const memInvalid = (v: string): boolean => v !== '' && !memoryLimitSchema.safeParse(v).success
  const cpuNum = cpuQuota === '' ? null : Number(cpuQuota)
  const cpuInvalid =
    cpuNum !== null && (!Number.isInteger(cpuNum) || cpuNum < 10 || cpuNum > maxQuota)
  const invalid = memInvalid(memoryHigh) || memInvalid(memoryMax) || cpuInvalid

  const dirty =
    memoryHigh !== (data.overrides.memoryHigh ?? '') ||
    memoryMax !== (data.overrides.memoryMax ?? '') ||
    cpuQuota !== (data.overrides.cpuQuotaPct != null ? String(data.overrides.cpuQuotaPct) : '')

  async function save() {
    setSaving(true)
    setSaveErr(null)
    setSaved(false)
    try {
      const patch: ResourcesPatch = {
        memoryHigh: memoryHigh === '' ? null : memoryHigh,
        memoryMax: memoryMax === '' ? null : memoryMax,
        cpuQuotaPct: cpuQuota === '' ? null : Number(cpuQuota),
      }
      await api.updateResources(patch)
      setSaved(true)
      await load()
    } catch (e) {
      setSaveErr(e instanceof ApiError ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="Resource limits"
      actions={
        <Button variant="primary" size="sm" disabled={saving || invalid || !dirty} onClick={save}>
          {saving ? <Spinner /> : 'Save'}
        </Button>
      }
    >
      <div className="space-y-3">
        {saveErr && <Banner tone="bad">{saveErr}</Banner>}
        {(saved || data.pendingRestart) && (
          <Banner tone="warn">Unapplied changes — restart the server for them to take effect.</Banner>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <LimitField
            label="Memory (soft limit)"
            hint="MemoryHigh — reclaim starts here"
            value={memoryHigh}
            invalid={memInvalid(memoryHigh)}
            placeholder={data.defaults.memoryHigh ?? 'unlimited'}
            onChange={setMemoryHigh}
          />
          <LimitField
            label="Memory (hard limit)"
            hint="MemoryMax — the OOM ceiling"
            value={memoryMax}
            invalid={memInvalid(memoryMax)}
            placeholder={data.defaults.memoryMax ?? 'unlimited'}
            onChange={setMemoryMax}
          />
          <LimitField
            label="CPU quota (%)"
            hint={`100 = one core · host max ${maxQuota}`}
            value={cpuQuota}
            invalid={cpuInvalid}
            placeholder="unlimited"
            onChange={setCpuQuota}
          />
        </div>
        <p className="cmd-note">
          Overrides the game's defaults ({data.defaults.memoryHigh ?? 'no'} soft /{' '}
          {data.defaults.memoryMax ?? 'no'} hard memory limit). Memory takes a K/M/G/T suffix, e.g.{' '}
          <span className="mono">8G</span>. Leave a field empty to use the default. Host has{' '}
          {data.host.cpus} cores and {formatBytes(data.host.memBytes)} RAM.
        </p>
      </div>
    </Card>
  )
}

function LimitField({
  label,
  hint,
  value,
  invalid,
  placeholder,
  onChange,
}: {
  label: string
  hint: string
  value: string
  invalid: boolean
  placeholder: string
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <div className="block">
      <label htmlFor={id} className="eyebrow mb-1.5 block">
        {label}
      </label>
      <input
        id={id}
        className={inputClass}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        style={invalid ? { borderColor: 'var(--bad, #e5484d)' } : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={`${id}-hint`} className="meta mt-1 block">
        {hint}
      </span>
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
