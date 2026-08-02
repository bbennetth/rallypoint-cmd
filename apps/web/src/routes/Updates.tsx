import { useEffect, useRef, useState } from 'react'
import type { LongOp, PanelUpdateInfo } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { useSseUpdates } from '../lib/useEventSource.js'
import { formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, Spinner } from '../ui/primitives.js'

export function UpdatesPage() {
  const [installedBuild, setInstalledBuild] = useState<string | null>(null)
  const [op, setOp] = useState<LongOp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const running = op?.status === 'running'
  const { log, progress, done, reset } = useSseUpdates('/api/updates/stream', running)
  const logRef = useRef<HTMLDivElement>(null)

  async function refresh() {
    const s = await api.updateState()
    setInstalledBuild(s.installedBuildId)
    setOp(s.op)
  }
  useEffect(() => {
    void refresh()
  }, [])

  // When the stream signals done, refresh the installed build + op state.
  useEffect(() => {
    if (done) void refresh()
  }, [done])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  async function run(kind: 'install' | 'update' | 'validate') {
    setErr(null)
    reset()
    try {
      setOp(await api.runUpdate(kind))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to start')
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title="SteamCMD"
        actions={
          <span className="text-xs text-panel-muted">
            installed build {installedBuild ?? '—'}
          </span>
        }
      >
        {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={running} onClick={() => run(installedBuild ? 'update' : 'install')}>
            {running ? <Spinner /> : null} {installedBuild ? 'Update server' : 'Install server'}
          </Button>
          <Button variant="ghost" disabled={running} onClick={() => run('validate')}>
            Validate files
          </Button>
          {op && (
            <Badge
              tone={op.status === 'succeeded' ? 'good' : op.status === 'failed' ? 'bad' : 'warn'}
            >
              {op.kind}: {op.status}
            </Badge>
          )}
        </div>
        {op?.status === 'failed' && op.error && (
          <p className="mono mt-3 text-sm text-panel-bad">{op.error}</p>
        )}
        <p className="mt-3 text-xs text-panel-muted">
          Updates stop the server first, run <span className="mono">app_update 2394010 validate</span>,
          then restart it.
        </p>
      </Card>

      <PanelUpdateCard
        opRunning={running}
        onStarted={(newOp) => {
          setErr(null)
          reset()
          setOp(newOp)
        }}
      />

      {(running || log.length > 0) && (
        <Card title="Progress">
          {progress != null && (
            <div className="mb-3">
              <div className="mb-1 flex justify-between text-xs text-panel-muted">
                <span>Downloading…</span>
                <span>{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-panel-surface-2">
                <div className="h-full bg-panel-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          <div
            ref={logRef}
            className="thin-scroll max-h-80 overflow-auto rounded-lg bg-black/40 p-3"
          >
            <pre className="mono whitespace-pre-wrap break-words text-xs text-panel-text/90">
              {log.join('\n') || 'Waiting for output…'}
            </pre>
          </div>
        </Card>
      )}
    </div>
  )
}

// Rallypoint's own updater: shows current vs latest GitHub release, runs
// the update as a long-op, then — because applying restarts the panel —
// polls /api/health until the NEW version answers and reloads the SPA.
function PanelUpdateCard({
  opRunning,
  onStarted,
}: {
  opRunning: boolean
  onStarted: (op: LongOp) => void
}) {
  const [info, setInfo] = useState<PanelUpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'updating' | 'restarting'>('idle')

  async function check(force: boolean) {
    setChecking(true)
    setErr(null)
    try {
      setInfo(await api.panelUpdate(force))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Update check failed')
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void check(false)
  }, [])

  async function runUpdate() {
    setErr(null)
    setPhase('updating')
    try {
      const op = await api.runPanelUpdate()
      onStarted(op)
      // Wait for the service restart: the SSE will drop; poll health until
      // a DIFFERENT version responds, then hard-reload to load the new SPA.
      const before = info?.current
      setPhase('restarting')
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const h = await api.health()
          if (h.version !== before) {
            window.location.reload()
            return
          }
          // Same version still answering: the op may have failed before the
          // restart. Ask for its state instead of spinning out the clock.
          const s = await api.updateState()
          if (s.op?.kind === 'panel_update' && s.op.status === 'failed') {
            setErr(s.op.error ?? 'Update failed — see the console below.')
            setPhase('idle')
            return
          }
        } catch {
          // panel is mid-restart — keep polling
        }
      }
      setErr('Panel did not come back with a new version — check the service manually.')
      setPhase('idle')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Update failed to start')
      setPhase('idle')
    }
  }

  return (
    <Card
      title="Rallypoint"
      actions={
        <span className="text-xs text-panel-muted">
          {info ? `v${info.current.replace(/^v/, '')}` : ''}
        </span>
      }
    >
      {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
      {phase === 'restarting' ? (
        <div className="flex items-center gap-3 text-sm text-panel-muted">
          <Spinner /> Applying update — the panel is restarting…
        </div>
      ) : !info ? (
        <p className="text-sm text-panel-muted">Checking for updates…</p>
      ) : info.updateAvailable && info.latest ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Badge tone="warn">update available</Badge>
            <span className="text-sm">
              {info.latest}
              {info.publishedAt && (
                <span className="ml-2 text-xs text-panel-muted">
                  {formatDateTime(Date.parse(info.publishedAt))}
                </span>
              )}
            </span>
          </div>
          {info.notes && (
            <pre className="thin-scroll max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-panel-surface-2 p-3 text-xs text-panel-muted">
              {info.notes}
            </pre>
          )}
          <div className="flex gap-2">
            <Button variant="primary" disabled={opRunning || phase !== 'idle'} onClick={runUpdate}>
              Update to {info.latest}
            </Button>
            <Button variant="ghost" disabled={checking} onClick={() => check(true)}>
              {checking ? <Spinner /> : 'Re-check'}
            </Button>
          </div>
          <p className="text-xs text-panel-muted">
            Downloads the release artifact, verifies it, swaps it in via the root helper, and
            restarts the panel. The game server keeps running.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Badge tone="good">up to date</Badge>
          <span className="text-xs text-panel-muted">
            last checked {info.checkedAtMs ? formatDateTime(info.checkedAtMs) : 'never'}
          </span>
          <Button variant="ghost" disabled={checking} onClick={() => check(true)}>
            {checking ? <Spinner /> : 'Check now'}
          </Button>
        </div>
      )}
    </Card>
  )
}
