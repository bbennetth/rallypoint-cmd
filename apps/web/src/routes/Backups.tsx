import { useEffect, useState } from 'react'
import type { Backup, LongOp, RestorePreview } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { useLongOp } from '../lib/useEventSource.js'
import { formatBytes, formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, inputClass, Spinner } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { ConfirmDialog } from '../ui/ConfirmDialog.js'
import { DataTable } from '../ui/DataTable.js'
import { Dialog } from '../ui/Dialog.js'
import { ProgressBar } from '../ui/ProgressBar.js'
import { Icon } from '../ui/ink/icons.js'
import { useFilePicker } from '../lib/useFilePicker.js'

const BACKUP_COLUMNS = [
  { key: 'created', header: 'Created' },
  { key: 'kind', header: 'Kind' },
  { key: 'world', header: 'World', cellClassName: 'mono text-xs text-[var(--ink-mute)]' },
  { key: 'size', header: 'Size' },
  { key: 'actions', header: 'Actions', align: 'right' as const },
]

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
  const [pendingDelete, setPendingDelete] = useState<Backup | null>(null)

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
    setBusy(id)
    try {
      await api.deleteBackup(id)
      await load()
    } finally {
      setBusy(null)
      setPendingDelete(null)
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
    }
  }
  const picker = useFilePicker(onUpload, { accept: '.gz,.tgz,application/gzip' })

  return (
    <div className="cmd-wide space-y-6">
      <div className="pg-head">
        <h1>Backups</h1>
      </div>

      <Card
        title="Backups"
        actions={
          <div className="flex gap-2">
            {picker.input}
            <Button variant="ghost" disabled={busy !== null} onClick={picker.open}>
              {busy === 'upload' ? <Spinner /> : <Icon name="upload" size={13} />} Upload & restore
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={create}>
              {busy === 'create' ? <Spinner /> : <Icon name="plus" size={13} />} Create backup
            </Button>
          </div>
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
        {activeOp && (
          <div className="cmd-op mb-4">
            <ProgressBar
              value={progress}
              label={activeOp.kind === 'backup' ? 'Creating backup…' : 'Restoring world…'}
              right={progress != null ? `${progress.toFixed(0)}%` : '…'}
            />
            {lastLine && <p className="meta mt-2 truncate">{lastLine}</p>}
          </div>
        )}
        {!backups ? (
          <p className="cmd-empty">Loading…</p>
        ) : (
          <DataTable
            columns={BACKUP_COLUMNS}
            empty="No backups yet."
            rows={backups.map((b) => ({
              id: b.id,
              cells: [
                formatDateTime(b.createdAtMs),
                <Badge
                  tone={b.kind === 'manual' ? 'muted' : b.kind === 'pre_restore' ? 'warn' : 'good'}
                >
                  {b.kind}
                </Badge>,
                b.worldId ? `${b.worldId.slice(0, 12)}…` : '—',
                formatBytes(b.sizeBytes),
                <div className="flex justify-end gap-2">
                  {/* Button inside the anchor, deliberately: the download is a
                      real link (right-click, middle-click, Save As all work)
                      and the e2e asserts on its button role. */}
                  <a href={api.downloadBackupUrl(b.id)} download>
                    <Button variant="ghost" size="sm">
                      Download
                    </Button>
                  </a>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy === b.id}
                    onClick={() => setPendingDelete(b)}
                  >
                    Delete
                  </Button>
                </div>,
              ],
            }))}
          />
        )}
      </Card>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete backup"
          body={`Delete the backup from ${formatDateTime(pendingDelete.createdAtMs)} permanently? This cannot be undone.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => del(pendingDelete.id)}
        />
      )}

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
  const required = preview.manifest.worldId ?? 'restore'

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
    <Dialog
      title="Confirm restore"
      onClose={busy ? () => {} : onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={restore} disabled={busy || confirmText !== required}>
            {busy ? <Spinner /> : null} Stop server & restore
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="cmd-empty">
          This will <span className="cmd-danger">stop the server</span> and replace the current
          world with the uploaded backup. The current world is snapshotted first for rollback. If
          the backup includes the game's server settings file it is imported too — panel-managed
          keys stay under panel control.
        </p>
        <dl className="cmd-kv space-y-1">
          <Row k="Backup world" v={preview.manifest.worldId ?? '—'} />
          <Row k="Current world" v={preview.currentWorldId ?? '— (none)'} />
          <Row k="Created" v={preview.manifest.createdAt} />
          <Row k="Build" v={preview.manifest.buildId ?? '—'} />
          <Row k="Files" v={String(preview.manifest.files.length)} />
        </dl>
        {preview.worldIdMismatch && (
          <Banner tone="warn">
            World ID differs from the running world — restoring will also point the server at the
            backup's world.
          </Banner>
        )}
        <div className="block">
          <label htmlFor="restore-confirm" className="eyebrow mb-1.5 block">
            {preview.manifest.worldId
              ? 'Type the backup world ID to confirm: '
              : 'Type to confirm: '}
            <span className="mono">{required}</span>
          </label>
          <input
            id="restore-confirm"
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

