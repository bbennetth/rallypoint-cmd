import { useEffect, useState } from 'react'
import type { LongOp, PanelUpdateInfo } from '@rallypoint-cmd/shared'
import { api, ApiError, apiScope } from '../lib/api.js'
import { useSseUpdates } from '../lib/useEventSource.js'
import { formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, Spinner } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { LogPane } from '../ui/LogPane.js'
import { ProgressBar } from '../ui/ProgressBar.js'

export function UpdatesPage() {
  const [installedBuild, setInstalledBuild] = useState<string | null>(null)
  const [op, setOp] = useState<LongOp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const running = op?.status === 'running'
  const { log, progress, done, reset } = useSseUpdates(`${apiScope()}/updates/stream`, running)

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
      <div className="pg-head">
        <h1>Updates</h1>
      </div>

      <Card
        title="SteamCMD"
        actions={<span className="meta">installed build {installedBuild ?? '—'}</span>}
      >
        {err && (
          <div className="mb-3">
            <Banner tone="bad">{err}</Banner>
          </div>
        )}
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
          <p className="mono cmd-danger mt-3 text-sm">{op.error}</p>
        )}
        <p className="cmd-note mt-3">
          Updates stop the server first, run <span className="mono">steamcmd app_update validate</span>,
          then restart it.
        </p>
      </Card>

      <PanelUpdateCard />

      {(running || log.length > 0) && (
        <Card title="Progress">
          {progress != null && (
            <div className="mb-3">
              <ProgressBar value={progress} label="Downloading…" right={`${progress.toFixed(1)}%`} />
            </div>
          )}
          <LogPane lines={log} maxHeight={320} autoscroll empty="Waiting for output…" />
        </Card>
      )}
    </div>
  )
}

// Rallypoint's own updater: shows current vs latest GitHub release, runs
// the update as a panel-scoped long-op, then — because applying restarts
// the panel — polls /api/health until the NEW version answers and reloads
// the SPA. Independent of any game server's update flow.
function PanelUpdateCard() {
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
      await api.runPanelUpdate()
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
      actions={<span className="meta">{info ? `v${info.current.replace(/^v/, '')}` : ''}</span>}
    >
      {err && (
        <div className="mb-3">
          <Banner tone="bad">{err}</Banner>
        </div>
      )}
      {phase === 'restarting' ? (
        <div className="cmd-empty flex items-center gap-3">
          <Spinner /> Applying update — the panel is restarting…
        </div>
      ) : !info ? (
        <p className="cmd-empty">Checking for updates…</p>
      ) : info.updateAvailable && info.latest ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Badge tone="warn">update available</Badge>
            <span className="text-sm">
              {info.latest}
              {info.publishedAt && (
                <span className="meta ml-2">{formatDateTime(Date.parse(info.publishedAt))}</span>
              )}
            </span>
          </div>
          {info.notes && <LogPane lines={info.notes} maxHeight={160} />}
          <div className="flex gap-2">
            <Button variant="primary" disabled={phase !== 'idle'} onClick={runUpdate}>
              Update to {info.latest}
            </Button>
            <Button variant="ghost" disabled={checking} onClick={() => check(true)}>
              {checking ? <Spinner /> : 'Re-check'}
            </Button>
          </div>
          <p className="cmd-note">
            Downloads the release artifact, verifies it, swaps it in via the root helper, and
            restarts the panel. The game server keeps running.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Badge tone="good">up to date</Badge>
          <span className="meta">
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
