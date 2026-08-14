import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GAMES, type GameServerSummary, type ServerLifecycle } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { formatBytes } from '../lib/format.js'
import { Badge, Button, Card, Field, Spinner, inputClass } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { Dialog } from '../ui/Dialog.js'
import { ConfirmDialog } from '../ui/ConfirmDialog.js'

const LIFECYCLE: Record<ServerLifecycle, { tone: 'good' | 'bad' | 'warn' | 'muted'; label: string }> = {
  active: { tone: 'good', label: 'Running' },
  activating: { tone: 'warn', label: 'Starting' },
  deactivating: { tone: 'warn', label: 'Stopping' },
  inactive: { tone: 'muted', label: 'Stopped' },
  failed: { tone: 'bad', label: 'Failed' },
  not_installed: { tone: 'muted', label: 'Not installed' },
}

// Home: one card per managed game server, plus the add-server flow.
export function ServersPage() {
  const navigate = useNavigate()
  const { data, refresh } = usePoll(api.servers, 5000)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<GameServerSummary | null>(null)

  if (!data)
    return (
      <div className="cmd-empty flex items-center gap-2">
        <Spinner /> Loading servers…
      </div>
    )

  return (
    <div className="space-y-6">
      <div className="pg-head flex items-center justify-between">
        <h1>Servers</h1>
        <Button onClick={() => setAdding(true)}>Add server</Button>
      </div>

      {err && <Banner tone="bad">{err}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.servers.map((s) => {
          const lc = LIFECYCLE[s.lifecycle]
          const game = GAMES[s.gameSlug]
          return (
            <Card key={s.id} title={s.name}>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="cmd-dim">{game?.name ?? s.gameSlug}</span>
                  <Badge tone={lc.tone}>{lc.label}</Badge>
                </div>
                <div className="cmd-dim text-sm">
                  {s.memoryCurrentBytes != null && <>mem {formatBytes(s.memoryCurrentBytes)} · </>}
                  {s.buildId ? `build ${s.buildId}` : 'not installed'}
                </div>
                <div className="flex gap-2 pt-1">
                  <Link to={`/servers/${s.id}`}>
                    <Button>Open</Button>
                  </Link>
                  {s.id !== data.defaultServerId && (
                    <Button variant="ghost" onClick={() => setRemoving(s)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      {adding && (
        <AddServerDialog
          existing={data.servers.map((s) => s.gameSlug)}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false)
            void refresh()
            navigate(`/servers/${id}/updates`)
          }}
          onError={setErr}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body="This unregisters the server from the panel. Game files and backups on disk are left untouched."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.deleteServer(removing.id)
              setRemoving(null)
              await refresh()
            } catch (e) {
              setRemoving(null)
              setErr(e instanceof ApiError ? e.message : 'Remove failed')
            }
          }}
        />
      )}
    </div>
  )
}

function AddServerDialog({
  existing,
  onClose,
  onCreated,
  onError,
}: {
  existing: string[]
  onClose: () => void
  onCreated: (id: string) => void
  onError: (msg: string) => void
}) {
  const games = useMemo(() => Object.values(GAMES), [])
  const [slug, setSlug] = useState(games.find((g) => !existing.includes(g.slug))?.slug ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const game = slug ? GAMES[slug] : undefined

  return (
    <Dialog title="Add server" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Game">
          <select
            className={inputClass}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          >
            {games.map((g) => (
              <option key={g.slug} value={g.slug} disabled={existing.includes(g.slug)}>
                {g.name}
                {existing.includes(g.slug) ? ' (already added)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {game && (
          <p className="cmd-dim text-sm">
            ~{game.diskEstimateGb} GB disk · {game.supportLevel === 'full'
              ? 'full support (settings, players, backups)'
              : 'basic support (install, start/stop, console, updates)'}
            {game.supportLevel === 'basic' &&
              ' — provision its unit on the host with: rallypoint-cmd-game add ' + game.slug}
          </p>
        )}
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={game?.name ?? 'My server'}
            maxLength={64}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !slug}
            onClick={async () => {
              if (!game) return
              setBusy(true)
              try {
                const created = await api.createServer(game.slug, name.trim() || game.name)
                onCreated(created.id)
              } catch (e) {
                onError(e instanceof ApiError ? e.message : 'Create failed')
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
