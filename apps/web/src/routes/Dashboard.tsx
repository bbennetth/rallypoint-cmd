import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PublicAccessConsole, PublicAccessStatus, ServerLifecycle } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { useLongOp } from '../lib/useEventSource.js'
import { formatBytes, formatUptime } from '../lib/format.js'
import { Badge, Button, Card, Spinner, Stat } from '../ui/primitives.js'

const LIFECYCLE: Record<ServerLifecycle, { tone: 'good' | 'bad' | 'warn' | 'muted'; label: string }> = {
  active: { tone: 'good', label: 'Running' },
  activating: { tone: 'warn', label: 'Starting' },
  deactivating: { tone: 'warn', label: 'Stopping' },
  inactive: { tone: 'muted', label: 'Stopped' },
  failed: { tone: 'bad', label: 'Failed' },
  not_installed: { tone: 'muted', label: 'Not installed' },
}

export function DashboardPage() {
  const { data: status, refresh } = usePoll(api.status, 3000)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function power(action: 'start' | 'stop' | 'restart') {
    setBusy(action)
    setErr(null)
    try {
      await api.power(action)
      await refresh()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  if (!status)
    return (
      <div className="flex items-center gap-2 text-panel-muted">
        <Spinner /> Loading status…
      </div>
    )

  const lc = LIFECYCLE[status.lifecycle]
  const running = status.lifecycle === 'active'
  const installed = status.lifecycle !== 'not_installed'
  const metrics = status.rest.metrics

  return (
    <div className="space-y-6">
      {status.pendingRestart && (
        <div className="flex items-center justify-between rounded-lg border border-panel-warn/40 bg-panel-warn/10 px-4 py-3 text-sm text-panel-warn">
          <span>Settings changed — restart the server to apply them.</span>
          <Button variant="warn" disabled={busy !== null} onClick={() => power('restart')}>
            Restart now
          </Button>
        </div>
      )}

      {!installed && (
        <Card title="Palworld is not installed">
          <div className="flex items-center justify-between">
            <p className="text-sm text-panel-muted">
              No dedicated server found on disk. Install it via SteamCMD to get started.
            </p>
            <Link to="/updates">
              <Button variant="primary">Install server</Button>
            </Link>
          </div>
        </Card>
      )}

      <Card
        title={
          <span className="flex items-center gap-3">
            Server
            <Badge tone={lc.tone}>
              {running && <span className="h-1.5 w-1.5 rounded-full bg-panel-good" />}
              {lc.label}
            </Badge>
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={!installed || running || busy !== null}
              onClick={() => power('start')}
            >
              {busy === 'start' ? <Spinner /> : '▶'} Start
            </Button>
            <Button
              variant="ghost"
              disabled={!running || busy !== null}
              onClick={() => power('restart')}
            >
              {busy === 'restart' ? <Spinner /> : '↻'} Restart
            </Button>
            <Button
              variant="danger"
              disabled={!running || busy !== null}
              onClick={() => power('stop')}
            >
              {busy === 'stop' ? <Spinner /> : '■'} Stop
            </Button>
          </div>
        }
      >
        {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Players"
            value={metrics ? `${metrics.currentplayernum}/${metrics.maxplayernum}` : '—'}
          />
          <Stat label="Server FPS" value={metrics ? metrics.serverfps : '—'} />
          <Stat
            label="Uptime"
            value={formatUptime(metrics?.uptime)}
            sub={status.rest.info?.version}
          />
          <Stat
            label="Memory"
            value={formatBytes(status.systemd.memoryCurrentBytes)}
            sub={`build ${status.buildId ?? '—'}`}
          />
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="World">
          <dl className="space-y-2 text-sm">
            <Row k="Name" v={status.rest.info?.servername ?? '—'} />
            <Row k="World ID" v={status.world.id ?? '—'} mono />
            <Row k="Version" v={status.rest.info?.version ?? '—'} />
            <Row k="systemd" v={`${status.systemd.activeState} / ${status.systemd.subState}`} />
            <Row k="REST API" v={status.rest.reachable ? 'reachable' : 'unreachable'} />
          </dl>
        </Card>

        <PublicAccessCard />

        <Card title="Storage">
          <div className="space-y-3">
            {status.disks.length === 0 && <p className="text-sm text-panel-muted">No disk data.</p>}
            {status.disks.map((d) => {
              const used = d.totalBytes - d.freeBytes
              const pct = d.totalBytes ? Math.round((used / d.totalBytes) * 100) : 0
              return (
                <div key={d.mount}>
                  <div className="mb-1 flex justify-between text-xs text-panel-muted">
                    <span>{d.label}</span>
                    <span>
                      {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-panel-surface-2">
                    <div
                      className={`h-full ${pct > 90 ? 'bg-panel-bad' : pct > 75 ? 'bg-panel-warn' : 'bg-panel-accent'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-panel-muted">{k}</dt>
      <dd className={`truncate text-right ${mono ? 'mono text-xs' : ''}`}>{v}</dd>
    </div>
  )
}

// Public Access (playit.gg): expose the game's UDP port to the internet
// without port-forwarding. Enable runs install→claim→start as a long-op;
// the claim URL must be approved by the user in their playit account.
function PublicAccessCard() {
  const [status, setStatus] = useState<PublicAccessStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleData, setConsoleData] = useState<PublicAccessConsole | null>(null)
  const { lastLine, progress, doneOp, reset } = useLongOp(busy)

  async function loadConsole() {
    try {
      setConsoleData(await api.publicAccessConsole())
    } catch {
      /* best-effort */
    }
  }
  // Refresh the console while open; faster while an op is running.
  useEffect(() => {
    if (!consoleOpen) return
    void loadConsole()
    const t = setInterval(() => void loadConsole(), busy ? 2000 : 5000)
    return () => clearInterval(t)
  }, [consoleOpen, busy])

  async function load() {
    try {
      setStatus(await api.publicAccess())
    } catch {
      /* status is best-effort */
    }
  }
  useEffect(() => {
    void load()
  }, [])
  // While enabling, poll status so pendingClaim (the approve URL) shows up.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [busy])
  useEffect(() => {
    if (!doneOp || doneOp.kind !== 'public_access') return
    if (doneOp.status === 'failed') setErr(doneOp.error ?? 'Enable failed')
    setBusy(false)
    reset()
    void load()
  }, [doneOp, reset])

  async function enable() {
    setErr(null)
    setBusy(true)
    try {
      await api.enablePublicAccess()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to start')
      setBusy(false)
    }
  }

  async function disable() {
    setErr(null)
    try {
      await api.disablePublicAccess()
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to stop')
    }
  }

  const online = status?.running && status.address

  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          Public access
          {status && (
            <Badge tone={online ? 'good' : status.running ? 'warn' : 'muted'}>
              {online ? 'online' : status.running ? 'no tunnel' : 'off'}
            </Badge>
          )}
        </span>
      }
      actions={
        <div className="flex gap-2">
          {status?.installed && (
            <Button variant="ghost" onClick={() => setConsoleOpen((v) => !v)}>
              {consoleOpen ? 'Hide console' : 'Console'}
            </Button>
          )}
          {status?.running && (
            <Button variant="ghost" onClick={disable}>
              Disable
            </Button>
          )}
        </div>
      }
    >
      {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
      {!status ? (
        <p className="text-sm text-panel-muted">Loading…</p>
      ) : busy ? (
        <div className="space-y-3">
          {status.pendingClaim ? (
            <div className="rounded-lg border border-panel-accent/40 bg-panel-accent/10 px-3 py-2 text-sm">
              Approve this server in your playit.gg account:{' '}
              <a
                className="font-medium text-panel-accent underline"
                href={status.pendingClaim.url}
                target="_blank"
                rel="noreferrer"
              >
                {status.pendingClaim.url}
              </a>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-panel-muted">
              <Spinner /> Setting up playit.gg…
            </div>
          )}
          <div className="h-2 overflow-hidden rounded-full bg-panel-surface-2">
            <div
              className={`h-full bg-panel-accent transition-all ${progress == null ? 'w-1/3 animate-pulse' : ''}`}
              style={progress != null ? { width: `${progress}%` } : undefined}
            />
          </div>
          {lastLine && <p className="mono truncate text-xs text-panel-muted">{lastLine}</p>}
        </div>
      ) : online ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="mono rounded-lg bg-panel-surface-2 px-3 py-1.5 text-sm">
              {status.address}
            </code>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(status.address ?? '')
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-panel-muted">
            Players join with this address — no port-forwarding needed (relayed via playit.gg).
          </p>
        </div>
      ) : status.running ? (
        <p className="text-sm text-panel-muted">
          Agent is running but no UDP tunnel targets port {status.gamePort ?? 8211}. Create one at{' '}
          <a
            className="text-panel-accent underline"
            href="https://playit.gg/account/tunnels"
            target="_blank"
            rel="noreferrer"
          >
            playit.gg/account/tunnels
          </a>{' '}
          (UDP → 127.0.0.1:{status.gamePort ?? 8211}) — the address appears here automatically.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-panel-muted">
            Let players join over the internet without port-forwarding, via a free{' '}
            <a
              className="text-panel-accent underline"
              href="https://playit.gg"
              target="_blank"
              rel="noreferrer"
            >
              playit.gg
            </a>{' '}
            UDP tunnel.
          </p>
          <Button variant="primary" onClick={enable}>
            Enable public access
          </Button>
        </div>
      )}

      {consoleOpen && (
        <div className="mt-4 space-y-3 border-t border-panel-border pt-3">
          <ConsoleSection
            title="Panel ⇄ playit"
            lines={(consoleData?.trace ?? []).map(
              (t) => `${new Date(t.ts).toLocaleTimeString()} [${t.kind}] ${t.line}`,
            )}
            empty="No panel↔playit activity yet."
          />
          <ConsoleSection
            title="Agent log"
            lines={consoleData?.agentLog ?? []}
            empty="No agent journal (agent not installed or no output)."
          />
        </div>
      )}
    </Card>
  )
}

function ConsoleSection({ title, lines, empty }: { title: string; lines: string[]; empty: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-panel-muted">
        {title}
      </div>
      <div className="thin-scroll max-h-48 overflow-auto rounded-lg bg-black/40 p-2">
        {lines.length === 0 ? (
          <p className="text-xs text-panel-muted">{empty}</p>
        ) : (
          <pre className="mono whitespace-pre-wrap break-words text-xs leading-relaxed">
            {lines.map((l, i) => (
              <div
                key={i}
                className={/error|failed|FAILED/i.test(l) ? 'text-panel-bad' : 'text-panel-text/90'}
              >
                {l}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}
