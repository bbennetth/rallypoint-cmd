import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PublicAccessConsole, PublicAccessStatus, ServerLifecycle } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { useLongOp } from '../lib/useEventSource.js'
import { formatBytes, formatUptime } from '../lib/format.js'
import { Badge, Button, Card, Spinner, Stat } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { ProgressBar } from '../ui/ProgressBar.js'
import { LogPane } from '../ui/LogPane.js'
import { Icon } from '../ui/ink/icons.js'

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
      <div className="cmd-empty flex items-center gap-2">
        <Spinner /> Loading status…
      </div>
    )

  const lc = LIFECYCLE[status.lifecycle]
  const running = status.lifecycle === 'active'
  const installed = status.lifecycle !== 'not_installed'
  const metrics = status.rest.metrics

  return (
    <div className="space-y-6">
      <div className="pg-head">
        <h1>Dashboard</h1>
      </div>

      {status.pendingRestart && (
        <Banner
          tone="warn"
          actions={
            <Button variant="warn" disabled={busy !== null} onClick={() => power('restart')}>
              Restart now
            </Button>
          }
        >
          Settings changed — restart the server to apply them.
        </Banner>
      )}

      {!installed && (
        <Card title="Palworld is not installed" size="title">
          <div className="flex items-center justify-between">
            <p className="cmd-empty">
              No dedicated server found on disk. Install it via SteamCMD to get started.
            </p>
            <Link to="updates">
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
              {running && <span className="cmd-dot" />}
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
              {busy === 'start' ? <Spinner /> : <Icon name="play" size={13} />} Start
            </Button>
            <Button
              variant="ghost"
              disabled={!running || busy !== null}
              onClick={() => power('restart')}
            >
              {busy === 'restart' ? <Spinner /> : <Icon name="repeat" size={13} />} Restart
            </Button>
            <Button
              variant="danger"
              disabled={!running || busy !== null}
              onClick={() => power('stop')}
            >
              {busy === 'stop' ? <Spinner /> : <Icon name="stop" size={13} />} Stop
            </Button>
          </div>
        }
      >
        {err && (
          <div className="mb-3">
            <Banner tone="bad">{err}</Banner>
          </div>
        )}
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
            {status.disks.length === 0 && <p className="cmd-empty">No disk data.</p>}
            {status.disks.map((d) => {
              const used = d.totalBytes - d.freeBytes
              const pct = d.totalBytes ? Math.round((used / d.totalBytes) * 100) : 0
              return (
                <ProgressBar
                  key={d.mount}
                  value={pct}
                  tone={pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'accent'}
                  label={d.label}
                  right={`${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`}
                />
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
      <dt className="eyebrow">{k}</dt>
      <dd className={`truncate text-right ${mono ? 'mono text-xs' : 'text-sm'}`}>{v}</dd>
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
      {err && (
        <div className="mb-3">
          <Banner tone="bad">{err}</Banner>
        </div>
      )}
      {!status ? (
        <p className="cmd-empty">Loading…</p>
      ) : busy ? (
        <div className="space-y-3">
          {status.pendingClaim ? (
            <Banner>
              Approve this server in your playit.gg account:{' '}
              <a className="cmd-link" href={status.pendingClaim.url} target="_blank" rel="noreferrer">
                {status.pendingClaim.url}
              </a>
            </Banner>
          ) : (
            <div className="flex items-center gap-2 text-sm text-[var(--ink-mute)]">
              <Spinner /> Setting up playit.gg…
            </div>
          )}
          <ProgressBar value={progress} />
          {lastLine && <p className="meta truncate">{lastLine}</p>}
        </div>
      ) : online ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="cmd-code">{status.address}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(status.address ?? '')
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="cmd-note">
            Players join with this address — no port-forwarding needed (relayed via playit.gg).
          </p>
        </div>
      ) : status.running ? (
        <p className="cmd-empty">
          Agent is running but no UDP tunnel targets port {status.gamePort ?? 8211}. Create one at{' '}
          <a
            className="cmd-link"
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
          <p className="cmd-empty">
            Let players join over the internet without port-forwarding, via a free{' '}
            <a className="cmd-link" href="https://playit.gg" target="_blank" rel="noreferrer">
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
        <div className="mt-4 space-y-3 border-t border-[var(--hairline-soft)] pt-3">
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
      <div className="pl-eyerow">
        <span className="eyebrow">{title}</span>
        <span className="ln" />
      </div>
      <LogPane lines={lines} empty={empty} maxHeight={192} errorPattern={/error|failed/i} />
    </div>
  )
}
