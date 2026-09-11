import { useEffect, useState } from 'react'
import type { LongOp } from '@rallypoint-cmd/shared'
import { api, ApiError, apiScope } from '../lib/api.js'
import { useAsyncData } from '../lib/usePoll.js'
import { useLongOp } from '../lib/useEventSource.js'
import { Badge, Button, Card, Spinner } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { LogPane } from '../ui/LogPane.js'
import { ProgressBar } from '../ui/ProgressBar.js'

export function UpdatesPage() {
  const [op, setOp] = useState<LongOp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const running = op?.status === 'running'
  // useLongOp, not a log-only stream: it handles the on-connect `op`
  // replay, which is the only signal left when an op finishes between the
  // GET /updates and the EventSource connecting.
  const { lines, progress, doneOp, reset } = useLongOp(running, `${apiScope()}/updates/stream`)
  const { data, error: loadError, refresh } = useAsyncData(api.updateState)
  const installedBuild = data?.installedBuildId ?? null
  // Until the first fetch lands we do not know whether this server is
  // installed — and the primary button's action depends on it. Acting on
  // a guess means running the wrong steamcmd op on a real server.
  const stateLoaded = data != null
  const banner = err ?? (loadError ? `Could not read the update state: ${loadError.message}` : null)

  useEffect(() => {
    if (data) setOp(data.op)
  }, [data])

  // When the stream signals done, refresh the installed build + op state.
  useEffect(() => {
    if (doneOp) void refresh()
  }, [doneOp, refresh])

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
        {banner && (
          <div className="mb-3">
            <Banner tone="bad">{banner}</Banner>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={running || !stateLoaded}
            onClick={() => run(installedBuild ? 'update' : 'install')}
          >
            {running ? <Spinner /> : null}{' '}
            {!stateLoaded ? 'Checking\u2026' : installedBuild ? 'Update server' : 'Install server'}
          </Button>
          <Button variant="ghost" disabled={running || !stateLoaded} onClick={() => run('validate')}>
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

      {(running || lines.length > 0) && (
        <Card title="Progress">
          {progress != null && (
            <div className="mb-3">
              <ProgressBar value={progress} label="Downloading…" right={`${progress.toFixed(1)}%`} />
            </div>
          )}
          <LogPane lines={lines} maxHeight={320} autoscroll empty="Waiting for output…" />
        </Card>
      )}
    </div>
  )
}
