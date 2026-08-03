import { useEffect, useState } from 'react'
import type { Mod } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { formatBytes, formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, Spinner } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { ConfirmDialog } from '../ui/ConfirmDialog.js'
import { DataTable } from '../ui/DataTable.js'
import { Icon } from '../ui/ink/icons.js'
import { useFilePicker } from '../lib/useFilePicker.js'

const MOD_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'size', header: 'Size' },
  { key: 'modified', header: 'Modified' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: 'Actions', align: 'right' as const },
]

export function ModsPage() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  // Mods only load on server boot — any successful change arms this
  // banner until the user restarts (or dismisses it).
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Mod | null>(null)

  async function load() {
    setMods((await api.mods()).mods)
  }
  useEffect(() => {
    void load()
  }, [])

  async function onUpload(file: File) {
    setBusy('upload')
    setErr(null)
    setOk(null)
    try {
      const result = await api.uploadMod(file)
      setMods(result.mods)
      setOk(
        result.installed.length === 1
          ? `Installed ${result.installed[0]}.`
          : `Installed ${result.installed.length} mods: ${result.installed.join(', ')}.`,
      )
      setRestartNeeded(true)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload rejected')
    } finally {
      setBusy(null)
    }
  }
  const picker = useFilePicker(onUpload, { accept: '.pak,.zip' })

  async function toggle(mod: Mod) {
    setBusy(mod.id)
    setErr(null)
    setOk(null)
    try {
      setMods((await api.toggleMod(mod.id, !mod.enabled)).mods)
      setRestartNeeded(true)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Toggle failed')
    } finally {
      setBusy(null)
    }
  }

  async function del(mod: Mod) {
    setBusy(mod.id)
    setErr(null)
    setOk(null)
    try {
      await api.deleteMod(mod.id)
      await load()
      setRestartNeeded(true)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Delete failed')
    } finally {
      setBusy(null)
      setPendingDelete(null)
    }
  }

  async function restart() {
    setBusy('restart')
    setErr(null)
    try {
      await api.power('restart')
      setRestartNeeded(false)
      setOk('Server restarting — mod changes will apply once it is back up.')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Restart failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="cmd-wide space-y-6">
      <div className="pg-head">
        <h1>Mods</h1>
      </div>

      <Card
        title="Mods"
        actions={
          <>
            {picker.input}
            <Button variant="primary" disabled={busy !== null} onClick={picker.open}>
              {busy === 'upload' ? <Spinner /> : <Icon name="upload" size={13} />} Upload mod
            </Button>
          </>
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
        {restartNeeded && (
          <div className="mb-4">
            <Banner
              tone="warn"
              actions={
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setRestartNeeded(false)}
                  >
                    Dismiss
                  </Button>
                  <Button variant="warn" size="sm" disabled={busy !== null} onClick={restart}>
                    {busy === 'restart' ? <Spinner /> : null} Restart server
                  </Button>
                </div>
              }
            >
              Mod changes take effect after a server restart.
            </Banner>
          </div>
        )}
        {!mods ? (
          <p className="cmd-empty">Loading…</p>
        ) : (
          <DataTable
            columns={MOD_COLUMNS}
            empty="No mods installed. Upload a .pak file (or a .zip containing one) to get started."
            rows={mods.map((m) => ({
              id: m.id,
              cells: [
                <>
                  <span className="mono">{m.id}</span>
                  {m.files.length > 1 && (
                    <span className="cmd-note ml-1.5">({m.files.length} files)</span>
                  )}
                </>,
                formatBytes(m.sizeBytes),
                formatDateTime(m.modifiedAtMs),
                <Badge tone={m.enabled ? 'good' : 'muted'}>
                  {m.enabled ? 'enabled' : 'disabled'}
                </Badge>,
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" disabled={busy === m.id} onClick={() => toggle(m)}>
                    {m.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy === m.id}
                    onClick={() => setPendingDelete(m)}
                  >
                    Delete
                  </Button>
                </div>,
              ],
            }))}
          />
        )}
        <p className="cmd-note mt-4">
          Mods are .pak files loaded from <span className="mono">Pal/Content/Paks/~mods</span> on the
          server. Disabling a mod parks it in a sibling folder without deleting it. Players may also
          need the same mod installed on their own game for it to work.
        </p>
      </Card>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete mod"
          body={
            <>
              Delete <span className="mono">{pendingDelete.pakFilename}</span> permanently? This
              cannot be undone.
            </>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => del(pendingDelete)}
        />
      )}
    </div>
  )
}
