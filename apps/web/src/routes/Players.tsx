import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { Badge, Button, Card, inputClass } from '../ui/primitives.js'
import { DataTable } from '../ui/DataTable.js'

const PLAYER_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'level', header: 'Level' },
  { key: 'ping', header: 'Ping' },
  { key: 'userId', header: 'User ID', cellClassName: 'mono text-xs text-[var(--ink-mute)]' },
  { key: 'actions', header: 'Actions', align: 'right' as const },
]

export function PlayersPage() {
  const { data, error, refresh } = usePoll(api.players, 5000)
  const [busy, setBusy] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')

  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key)
    try {
      await fn()
      await refresh()
    } catch {
      /* surfaced via poll error / no-op */
    } finally {
      setBusy(null)
    }
  }

  const offline = error instanceof ApiError && error.status === 503

  return (
    <div className="cmd-wide space-y-6">
      <div className="pg-head">
        <h1>Players</h1>
      </div>

      <Card
        title="Broadcast"
        actions={<span className="meta">{data ? `${data.players.length} online` : ''}</span>}
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (announce.trim())
              void act(async () => {
                await api.announce(announce.trim())
                setAnnounce('')
              }, 'announce')
          }}
        >
          <input
            className={inputClass}
            placeholder="Message to all players…"
            value={announce}
            onChange={(e) => setAnnounce(e.target.value)}
          />
          <Button variant="primary" className="grow" disabled={busy === 'announce' || !announce.trim()}>
            Send
          </Button>
        </form>
      </Card>

      <Card title="Players">
        {offline ? (
          <p className="cmd-empty">Server is offline — player list unavailable.</p>
        ) : (
          <DataTable
            columns={PLAYER_COLUMNS}
            empty="No players online."
            rows={(data?.players ?? []).map((p) => ({
              id: p.userId,
              cells: [
                <span className="font-medium">{p.name}</span>,
                p.level ?? '—',
                <Badge tone={(p.ping ?? 0) < 80 ? 'good' : 'warn'}>{p.ping ?? '—'} ms</Badge>,
                p.userId,
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === p.userId}
                    onClick={() => act(() => api.kick(p.userId), p.userId)}
                  >
                    Kick
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy === p.userId}
                    onClick={() => act(() => api.ban(p.userId), p.userId)}
                  >
                    Ban
                  </Button>
                </div>,
              ],
            }))}
          />
        )}
      </Card>
    </div>
  )
}
