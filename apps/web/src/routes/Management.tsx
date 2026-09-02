import { useEffect, useState } from 'react'
import {
  GAMES,
  type BackupDirEntry,
  type GameDirEntry,
  type LongOp,
  type PanelHost,
  type PanelStorage,
  type PanelUpdateInfo,
  type WineStatus,
} from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { useLongOp, useSseLines } from '../lib/useEventSource.js'
import { formatBytes, formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, inputClass, Spinner } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { DataTable } from '../ui/DataTable.js'
import { Dialog } from '../ui/Dialog.js'
import { LogPane } from '../ui/LogPane.js'
import { ProgressBar } from '../ui/ProgressBar.js'

// Panel-level management: Rallypoint's own updater plus disk reclaim.
// Both are panel concerns, not server concerns — this page exists (and
// sits in the nav) whether or not any game server is registered.

export function ManagementPage() {
  // Wine only matters if something here actually runs under it — join the
  // registered servers' game slugs against the GAMES registry and look for
  // a Windows-platform game.
  const [hasWindowsServer, setHasWindowsServer] = useState(false)
  useEffect(() => {
    api
      .servers()
      .then((r) =>
        setHasWindowsServer(r.servers.some((s) => GAMES[s.gameSlug]?.platform === 'windows')),
      )
      .catch(() => {})
  }, [])

  return (
    <div className="cmd-wide space-y-6">
      <div className="pg-head">
        <h1>Management</h1>
      </div>

      <PanelUpdateCard />

      {hasWindowsServer && <WineCard />}

      <HostCard />

      <StorageSection />
    </div>
  )
}

// Rallypoint's own updater: shows current vs latest GitHub release, runs
// the update as a panel-scoped long-op, then — because applying restarts
// the panel — polls /api/health until the NEW version answers and reloads
// the SPA. Independent of any game server's update flow.
// Slow governors ramp CPU clocks lazily — game-server tick bursts start
// on down-clocked cores and overrun their deadline ("Bad Performance"
// log spam) even at low average load.
const SLOW_GOVERNORS = ['powersave', 'conservative']

// Read-only host facts. The governor is host-level (Proxmox), not
// something the panel's container can change — so this card displays it
// and, when it's a slow one, explains how to change it on the host.
function HostCard() {
  const [host, setHost] = useState<PanelHost | null>(null)
  const [showHowTo, setShowHowTo] = useState(false)

  useEffect(() => {
    api.panelHost().then(setHost).catch(() => {
      /* best-effort — the card just stays in its loading state */
    })
  }, [])

  const governor = host?.cpuGovernor ?? null
  const slow = governor !== null && SLOW_GOVERNORS.includes(governor)

  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          Host
          {governor && <Badge tone={slow ? 'warn' : 'good'}>{governor}</Badge>}
        </span>
      }
    >
      {!host ? (
        <p className="cmd-empty">Loading…</p>
      ) : (
        <div className="space-y-3">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="eyebrow">CPU governor</dt>
              <dd>{governor ?? 'not exposed'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="eyebrow">CPUs</dt>
              <dd>{host.cpuCount}</dd>
            </div>
          </dl>

          {slow && (
            <Banner tone="warn">
              The host CPU governor is <code className="cmd-code">{governor}</code> — cores ramp up
              slowly, which causes game tick overruns (e.g. Enshrouded&apos;s &ldquo;Bad
              Performance&rdquo; warnings) even when average CPU load is low.{' '}
              <button className="cmd-link" onClick={() => setShowHowTo((v) => !v)}>
                {showHowTo ? 'Hide fix' : 'How to fix'}
              </button>
            </Banner>
          )}

          {slow && showHowTo && (
            <div className="space-y-2 text-sm">
              <p className="cmd-note">
                The governor is set on the <strong>host</strong> (e.g. Proxmox), not in this
                container — the panel can only read it. On the host, as root:
              </p>
              <pre className="cmd-code block overflow-x-auto p-3 text-xs">
                {`# apply now (reverts on reboot)
echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# make it persistent
cat > /etc/systemd/system/cpu-governor.service <<'EOF'
[Unit]
Description=Set CPU governor to performance

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now cpu-governor.service`}
              </pre>
              <p className="cmd-note">
                If the governor was set deliberately (e.g. in{' '}
                <code className="cmd-code">/etc/default/cpufrequtils</code>), change it there
                instead. <code className="cmd-code">schedutil</code> is a good middle ground if you
                want to keep some power saving. This page reflects the change on reload.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

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
          // restart. Ask the panel runner for its state instead of spinning
          // out the clock.
          const s = await api.panelOp()
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
            Downloads the release artifact, verifies it, swaps it in, and restarts the panel.
            Game servers keep running.
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

// ---------------------------------------------------------------------------
// Wine: only relevant when a Windows-platform game (Enshrouded and
// friends) is registered — those servers run under Wine, and the WineHQ
// *staging* branch is the one that ships esync/fsync. Plain Wine falls
// back to poll-based synchronisation, which starves the game's tick.
// Unlike the panel update, upgrading Wine does NOT restart the panel.

function wineErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Upgrade failed to start'
  if (e.code === 'unit_active') return 'Stop the Windows game server(s) before upgrading Wine.'
  if (e.code === 'world_busy' || e.code === 'op_running')
    return 'Another operation is already running — try again once it finishes.'
  return e.message
}

function WineCard() {
  const [status, setStatus] = useState<WineStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [activeOp, setActiveOp] = useState<LongOp | null>(null)
  const { progress, doneOp, reset } = useLongOp(activeOp !== null, '/api/panel/stream')
  const { lines, clear } = useSseLines('/api/panel/stream', 'log', {
    enabled: activeOp !== null,
  })

  async function load() {
    try {
      setStatus(await api.wineStatus())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load Wine status')
    }
  }
  useEffect(() => {
    void load()
    // Re-attach to an upgrade already in flight (navigation, reload).
    api
      .panelOp()
      .then((s) => {
        if (s.op?.status === 'running' && s.op.kind === 'wine_update') setActiveOp(s.op)
      })
      .catch(() => {})
  }, [])

  // Op finished: the panel and the games kept running either way, so a
  // failure is simply retryable — surface it and refresh the version.
  useEffect(() => {
    if (!doneOp || !activeOp || doneOp.id !== activeOp.id) return
    if (doneOp.status === 'failed') {
      setErr(`Wine upgrade failed: ${doneOp.error ?? 'unknown error'} — safe to retry.`)
      setOk(null)
    } else {
      setErr(null)
      setOk('Wine upgraded — restart the Windows game server(s) to pick up esync/fsync.')
    }
    setActiveOp(null)
    reset()
    void load()
  }, [doneOp, activeOp, reset])

  async function upgrade() {
    setErr(null)
    setOk(null)
    clear()
    try {
      setActiveOp(await api.runWineUpgrade())
    } catch (e) {
      setErr(wineErrorMessage(e))
    }
  }

  const running = activeOp !== null

  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          Wine
          {status?.staging && <Badge tone="good">Staging</Badge>}
        </span>
      }
      actions={
        <span className="meta">
          {status ? (status.installed ? (status.version ?? 'installed') : 'not installed') : ''}
        </span>
      }
    >
      {err && (
        <div className="mb-3">
          <Banner tone="bad">{err}</Banner>
        </div>
      )}
      {ok && (
        <div className="mb-3">
          <Banner tone="ok">{ok}</Banner>
        </div>
      )}
      {!status ? (
        <p className="cmd-empty">Loading…</p>
      ) : (
        <div className="space-y-3">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="eyebrow">Version</dt>
              <dd>{status.installed ? (status.version ?? 'unknown') : 'not installed'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="eyebrow">Branch</dt>
              <dd>{status.staging ? 'WineHQ staging' : 'stable / distro'}</dd>
            </div>
          </dl>

          {running && (
            <div className="cmd-op">
              <ProgressBar
                value={progress}
                label="Upgrading Wine…"
                right={progress != null ? `${progress.toFixed(0)}%` : '…'}
              />
            </div>
          )}
          {running && lines.length > 0 && <LogPane lines={lines} maxHeight={200} />}

          {!status.staging && status.upgradeSupported && (
            <div className="flex gap-2">
              <Button variant="primary" disabled={running} onClick={upgrade}>
                {running ? <Spinner /> : null} Upgrade to WineHQ staging
              </Button>
            </div>
          )}
          {!status.staging && !status.upgradeSupported && (
            <p className="cmd-note">
              This OS release isn&apos;t supported by the WineHQ repository, so the panel can&apos;t
              install the staging build here.
            </p>
          )}

          <p className="cmd-note">
            WineHQ staging enables esync/fsync, which cuts tick starvation for Windows-only servers
            like Enshrouded. The panel keeps running through the upgrade — no restart needed.
          </p>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Disk + storage: panel-wide disk usage and what actually sits under the
// games/backups roots — including orphan directories left behind by
// server deletion (which is an unregistration, not an uninstall).

type DeleteTarget =
  | { kind: 'game'; entry: GameDirEntry }
  | { kind: 'backup'; entry: BackupDirEntry }

const GAME_COLUMNS = [
  { key: 'dir', header: 'Directory' },
  { key: 'status', header: 'Status' },
  { key: 'size', header: 'Size' },
  { key: 'actions', header: 'Actions', align: 'right' as const },
]

const BACKUP_COLUMNS = [
  { key: 'dir', header: 'Directory' },
  { key: 'server', header: 'Server' },
  { key: 'size', header: 'Size' },
  { key: 'actions', header: 'Actions', align: 'right' as const },
]

function StorageSection() {
  const [storage, setStorage] = useState<PanelStorage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null)
  // The delete op we launched (or re-attached to); while set, its
  // progress + final status stream over the panel SSE.
  const [activeOp, setActiveOp] = useState<LongOp | null>(null)
  const { progress, lastLine, doneOp, reset } = useLongOp(activeOp !== null, '/api/panel/stream')

  async function load() {
    try {
      setStorage(await api.panelStorage())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load storage')
    }
  }
  useEffect(() => {
    void load()
    // Re-attach to a delete already in flight (navigation, reload).
    api
      .panelOp()
      .then((s) => {
        if (
          s.op?.status === 'running' &&
          (s.op.kind === 'delete_game_files' || s.op.kind === 'delete_backup_dir')
        ) {
          setActiveOp(s.op)
        }
      })
      .catch(() => {})
  }, [])

  // Op finished: surface the result (esp. the error) and refresh the view.
  useEffect(() => {
    if (!doneOp || !activeOp || doneOp.id !== activeOp.id) return
    if (doneOp.status === 'failed') {
      setErr(`${doneOp.kind} failed: ${doneOp.error ?? 'unknown error'}`)
      setOk(null)
    } else {
      setErr(null)
      setOk(
        doneOp.kind === 'delete_game_files'
          ? 'Game files deleted.'
          : 'Backup directory deleted.',
      )
    }
    setActiveOp(null)
    reset()
    void load()
  }, [doneOp, activeOp, reset])

  const opRunning = activeOp !== null

  return (
    <>
      <Card title="Disks">
        {!storage ? (
          <p className="cmd-empty">Loading…</p>
        ) : storage.disks.length === 0 ? (
          <p className="cmd-empty">No disk data.</p>
        ) : (
          <div className="space-y-3">
            {storage.disks.map((d) => {
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
        )}
      </Card>

      <Card title="Game files">
        {err && (
          <div className="mb-3">
            <Banner tone="bad">{err}</Banner>
          </div>
        )}
        {ok && (
          <div className="mb-3">
            <Banner tone="ok">{ok}</Banner>
          </div>
        )}
        {activeOp && (
          <div className="cmd-op mb-4">
            <ProgressBar
              value={progress}
              label={
                activeOp.kind === 'delete_game_files'
                  ? 'Deleting game files…'
                  : 'Deleting backup directory…'
              }
              right={progress != null ? `${progress.toFixed(0)}%` : '…'}
            />
            {lastLine && <p className="meta mt-2 truncate">{lastLine}</p>}
          </div>
        )}
        {!storage ? (
          <p className="cmd-empty">Loading…</p>
        ) : (
          <DataTable
            columns={GAME_COLUMNS}
            empty="Nothing on disk under the games root."
            rows={storage.games.map((g) => ({
              id: g.name,
              cells: [
                <span>
                  <span className="mono">{g.name}</span>
                  {GAMES[g.name] && <span className="meta ml-2">{GAMES[g.name]?.name}</span>}
                </span>,
                g.registered ? (
                  <span className="flex items-center gap-2">
                    <span className="truncate">{g.serverName}</span>
                    {g.running && <Badge tone="warn">running</Badge>}
                  </span>
                ) : g.deletable ? (
                  <Badge tone="warn">orphaned</Badge>
                ) : (
                  <Badge tone="muted">unmanaged</Badge>
                ),
                formatBytes(g.sizeBytes),
                <div className="flex justify-end">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!g.deletable || g.running === true || opRunning}
                    onClick={() => setPendingDelete({ kind: 'game', entry: g })}
                  >
                    Delete files
                  </Button>
                </div>,
              ],
            }))}
          />
        )}
        <p className="cmd-note mt-3">
          Deleting a game's files removes its entire install directory to reclaim disk. The server
          entry, its backups and its systemd unit are kept — reinstall from the server's Updates
          tab. Running servers must be stopped first.
        </p>
      </Card>

      <Card title="Backup storage">
        {!storage ? (
          <p className="cmd-empty">Loading…</p>
        ) : (
          <DataTable
            columns={BACKUP_COLUMNS}
            empty="No backup directories on disk."
            rows={storage.backups.map((b) => ({
              id: b.id,
              cells: [
                <span className="mono">{b.id}</span>,
                b.orphan ? <Badge tone="warn">orphaned</Badge> : <span>{b.serverName}</span>,
                formatBytes(b.sizeBytes),
                <div className="flex justify-end">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={opRunning}
                    onClick={() => setPendingDelete({ kind: 'backup', entry: b })}
                  >
                    Delete
                  </Button>
                </div>,
              ],
            }))}
          />
        )}
        <p className="cmd-note mt-3">
          Each directory holds one server's backup archives, kept on disk even after the server is
          removed from the panel. Deleting one removes every archive in it.
        </p>
      </Card>

      {pendingDelete && (
        <DeleteDialog
          target={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onStarted={(op) => {
            // Delete launched: close the dialog and stream its progress
            // inline; completion/errors surface via the op card above.
            setPendingDelete(null)
            setErr(null)
            setOk(null)
            setActiveOp(op)
          }}
        />
      )}
    </>
  )
}

function DeleteDialog({
  target,
  onClose,
  onStarted,
}: {
  target: DeleteTarget
  onClose: () => void
  onStarted: (op: LongOp) => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const required = target.kind === 'game' ? target.entry.name : target.entry.id
  const game = target.kind === 'game' ? GAMES[target.entry.name] : undefined

  async function run() {
    setBusy(true)
    setErr(null)
    try {
      onStarted(
        target.kind === 'game'
          ? await api.deleteGameDir(target.entry.name, confirmText)
          : await api.deleteBackupDir(target.entry.id, confirmText),
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Delete failed to start')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={target.kind === 'game' ? 'Delete game files' : 'Delete backup directory'}
      onClose={busy ? () => {} : onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={busy || confirmText !== required}>
            {busy ? <Spinner /> : null} Delete permanently
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Banner tone="warn">
          {target.kind === 'game' ? (
            <>
              This permanently deletes the entire install directory — including any worlds or saves
              stored inside it. {target.entry.registered ? 'The server entry, its backups and its systemd unit are kept; the game can be reinstalled from its Updates tab.' : 'Nothing in the panel references this directory any more.'}
            </>
          ) : target.entry.orphan ? (
            <>
              This permanently deletes this orphaned backup directory and every archive in it.
            </>
          ) : (
            <>
              This permanently deletes every backup archive for {target.entry.serverName ?? 'this server'} and
              clears its backup history — the server's Backups tab will be empty.
            </>
          )}
        </Banner>
        <dl className="cmd-kv space-y-1">
          <Row
            k="Directory"
            v={target.kind === 'game' ? target.entry.name : target.entry.id}
          />
          {game && <Row k="Game" v={game.name} />}
          {target.kind === 'game' && target.entry.serverName && (
            <Row k="Server" v={target.entry.serverName} />
          )}
          {target.kind === 'backup' && target.entry.serverName && (
            <Row k="Server" v={target.entry.serverName} />
          )}
          <Row k="Size" v={formatBytes(target.entry.sizeBytes)} />
        </dl>
        <div className="block">
          <label htmlFor="storage-delete-confirm" className="eyebrow mb-1.5 block">
            Type the directory name to confirm: <span className="mono">{required}</span>
          </label>
          <input
            id="storage-delete-confirm"
            className={inputClass}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
        </div>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="eyebrow">{k}</dt>
      <dd className="mono truncate text-right text-xs">{v}</dd>
    </div>
  )
}
