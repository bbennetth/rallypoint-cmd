import { useEffect, useRef, useState } from 'react'
import type { Mod } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { formatBytes, formatDateTime } from '../lib/format.js'
import { Badge, Button, Card, Spinner } from '../ui/primitives.js'

export function ModsPage() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  // Mods only load on server boot — any successful change arms this
  // banner until the user restarts (or dismisses it).
  const [restartNeeded, setRestartNeeded] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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
      if (fileRef.current) fileRef.current.value = ''
    }
  }

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
    if (!confirm(`Delete ${mod.pakFilename} permanently?`)) return
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
    <div className="space-y-6">
      <Card
        title="Mods"
        actions={
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pak,.zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUpload(f)
              }}
            />
            <Button variant="primary" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
              {busy === 'upload' ? <Spinner /> : '↑'} Upload mod
            </Button>
          </div>
        }
      >
        {err && <p className="mb-3 text-sm text-panel-bad">{err}</p>}
        {ok && <p className="mb-3 text-sm text-panel-good">{ok}</p>}
        {restartNeeded && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-panel-warn/40 bg-panel-warn/10 px-4 py-3 text-sm text-panel-warn">
            <span>Mod changes take effect after a server restart.</span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busy !== null} onClick={() => setRestartNeeded(false)}>
                Dismiss
              </Button>
              <Button variant="primary" disabled={busy !== null} onClick={restart}>
                {busy === 'restart' ? <Spinner /> : null} Restart server
              </Button>
            </div>
          </div>
        )}
        {!mods ? (
          <p className="text-panel-muted">Loading…</p>
        ) : mods.length === 0 ? (
          <p className="text-sm text-panel-muted">
            No mods installed. Upload a .pak file (or a .zip containing one) to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-panel-border text-left text-xs uppercase text-panel-muted">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Size</th>
                  <th className="pb-2 pr-3">Modified</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mods.map((m) => (
                  <tr key={m.id} className="border-b border-panel-border/50">
                    <td className="py-2 pr-3">
                      <span className="mono">{m.id}</span>
                      {m.files.length > 1 && (
                        <span className="ml-1.5 text-xs text-panel-muted">
                          ({m.files.length} files)
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{formatBytes(m.sizeBytes)}</td>
                    <td className="py-2 pr-3">{formatDateTime(m.modifiedAtMs)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={m.enabled ? 'good' : 'muted'}>
                        {m.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" disabled={busy === m.id} onClick={() => toggle(m)}>
                          {m.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button variant="danger" disabled={busy === m.id} onClick={() => del(m)}>
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
        <p className="mt-4 text-xs text-panel-muted">
          Mods are .pak files loaded from <span className="mono">Pal/Content/Paks/~mods</span> on the
          server. Disabling a mod parks it in a sibling folder without deleting it. Players may also
          need the same mod installed on their own game for it to work.
        </p>
      </Card>
    </div>
  )
}
