import { useEffect, useRef, useState } from 'react'
import type { Backup, LongOp, RestorePreview } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { useLongOp } from '../lib/useEventSource.js'
import { formatBytes, formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, inputClass, Spinner } from '../ui/primitives.js'

export function BackupsPage() {
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  // The op we launched (backup or restore); while set, we stream its
  // progress + final status over SSE instead of blind-polling.
  const [activeOp, setActiveOp] = useState<LongOp | null>(null)
  const { progress, lastLine, doneOp, reset } = useLongOp(activeOp !== null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    setBackups((await api.backups()).backups)
  }
  useEffect(() => {
    void load()
  }, [])

  // Op finished: surface the result (esp. the error) and refresh the list.
  useEffect(() => {
    if (!doneOp || !activeOp || doneOp.id !== activeOp.id) return
    if (doneOp.status === 'failed') {
      setErr(`${doneOp.kind} failed: ${doneOp.error ?? 'unknown error'}`)
      setOk(null)
    } else {
      setErr(null)
      // Persistent confirmation — without it a finished op just vanishes
      // and success is indistinguishable from a silent failure.
      setOk(
        doneOp.kind === 'restore'
          ? 'Restore complete — the uploaded world is now the active save.'
          : 'Backup created.',
      )
    }
    setActiveOp(null)
    setBusy(null)
    reset()
    void load()
  }, [doneOp, activeOp, reset])

  async function create() {
    setBusy('create')
    setErr(null)
    setOk(null)
    try {
      setActiveOp(await api.createBackup())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Backup failed')
      setBusy(null)
    }
  }

  async function del(id: string) {
    if (!confirm('Delete this backup permanently?')) return
    setBusy(id)
    try {
      await api.deleteBackup(id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function onUpload(file: File) {
    setBusy('upload')
    setErr(null)
    setOk(null)
    try {
      setPreview(await api.uploadBackup(file))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload rejected')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title="Backups"
        actions={
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUpload(f)
              }}
            />
            <Button variant="ghost" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
              {busy === 'upload' ? <Spinner /> : '↑'} Upload & restore
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={create}>
              {busy === 'create' ? <Spinner /> : '＋'} Create backup
            </Button>
          </div>
        }
      >
        {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
        {ok && <p className="mb-3 text-sm text-panel-good">{ok}</p>}
        {activeOp && (
          <div className="mb-4 rounded-lg border border-panel-border bg-panel-surface-2 px-4 py-3">
            <div className="mb-1 flex justify-between text-xs text-panel-muted">
              <span className="capitalize">
                {activeOp.kind === 'backup' ? 'Creating backup…' : 'Restoring world…'}
              </span>
              <span>{progress != null ? `${progress.toFixed(0)}%` : '…'}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-panel-bg">
              <div
                className={`h-full bg-panel-accent transition-all ${progress == null ? 'w-1/3 animate-pulse' : ''}`}
                style={progress != null ? { width: `${progress}%` } : undefined}
              />
            </div>
            {lastLine && <p className="mono mt-2 truncate text-xs text-panel-muted">{lastLine}</p>}
          </div>
        )}
        {!backups ? (
          <p className="text-panel-muted">Loading…</p>
        ) : backups.length === 0 ? (
          <p className="text-sm text-panel-muted">No backups yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-panel-border text-left text-xs uppercase text-panel-muted">
                  <th className="pb-2 pr-3">Created</th>
                  <th className="pb-2 pr-3">Kind</th>
                  <th className="pb-2 pr-3">World</th>
                  <th className="pb-2 pr-3">Size</th>
                  <th className="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id} className="border-b border-panel-border/50">
                    <td className="py-2 pr-3">{formatDateTime(b.createdAtMs)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={b.kind === 'manual' ? 'muted' : b.kind === 'pre_restore' ? 'warn' : 'good'}>
                        {b.kind}
                      </Badge>
                    </td>
                    <td className="mono py-2 pr-3 text-xs text-panel-muted">{b.worldId.slice(0, 12)}…</td>
                    <td className="py-2 pr-3">{formatBytes(b.sizeBytes)}</td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <a href={api.downloadBackupUrl(b.id)} download>
                          <Button variant="ghost">Download</Button>
                        </a>
                        <Button variant="danger" disabled={busy === b.id} onClick={() => del(b.id)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {preview && (
        <RestoreDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onStarted={(op) => {
            // Restore launched: close the dialog and stream its progress
            // inline; completion/errors surface via the op card above.
            setPreview(null)
            setBusy('restore')
            setActiveOp(op)
          }}
        />
      )}
    </div>
  )
}

function RestoreDialog({
  preview,
  onClose,
  onStarted,
}: {
  preview: RestorePreview
  onClose: () => void
  onStarted: (op: LongOp) => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const required = preview.manifest.worldId

  async function restore() {
    setBusy(true)
    setErr(null)
    try {
      onStarted(await api.restoreBackup(preview.stagingId, confirmText))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Restore failed')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <Card title="Confirm restore" className="w-full max-w-lg">
        <div className="space-y-3 text-sm">
          <p className="text-panel-muted">
            This will <span className="text-panel-bad">stop the server</span> and replace the current
            world with the uploaded backup. The current world is snapshotted first for rollback. If
            the backup includes server settings (PalWorldSettings.ini) they are imported too —
            panel-managed keys (REST API, RCON, admin password) stay under panel control.
          </p>
          <dl className="space-y-1 rounded-lg bg-panel-surface-2 p-3 text-xs">
            <Row k="Backup world" v={preview.manifest.worldId} />
            <Row k="Current world" v={preview.currentWorldId ?? '— (none)'} />
            <Row k="Created" v={preview.manifest.createdAt} />
            <Row k="Build" v={preview.manifest.buildId ?? '—'} />
            <Row k="Files" v={String(preview.manifest.files.length)} />
          </dl>
          {preview.worldIdMismatch && (
            <p className="rounded-lg border border-panel-warn/40 bg-panel-warn/10 px-3 py-2 text-xs text-panel-warn">
              World ID differs from the running world — restoring will also point the server at the
              backup's world.
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-panel-muted">
              Type the backup world ID to confirm: <span className="mono">{required}</span>
            </span>
            <input className={inputClass} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </label>
          {err && <p className="text-sm text-panel-bad">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={restore} disabled={busy || confirmText !== required}>
              {busy ? <Spinner /> : null} Stop server & restore
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-panel-muted">{k}</dt>
      <dd className="mono truncate text-right">{v}</dd>
    </div>
  )
}

