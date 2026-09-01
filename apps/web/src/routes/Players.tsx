import { useState } from 'react'
import { playerAdminFeatures, playerFields, type GameDef } from '@rallypoint-cmd/shared'
import { api, ApiError } from '../lib/api.js'
import { usePoll } from '../lib/usePoll.js'
import { useCurrentGame } from '../lib/useCurrentGame.js'
import { Badge, Button, Card, inputClass } from '../ui/primitives.js'
import { DataTable } from '../ui/DataTable.js'

// What a game reports about a player varies by admin protocol: Palworld's
// REST API gives level and ping, an RCON `status` gives ping only, and
// Project Zomboid gives nothing but a name. Columns the game's protocol
// can never fill are dropped — driven by the protocol rather than by the
// rows in hand, so the table doesn't reshape itself as players come and
// go (or show nothing at all on an empty server).
function columnsFor(game: GameDef | undefined) {
  const has = game ? playerFields(game) : { level: true, ping: true }
  return [
    { key: 'name', header: 'Name' },
    ...(has.level ? [{ key: 'level', header: 'Level' }] : []),
    ...(has.ping ? [{ key: 'ping', header: 'Ping' }] : []),
    { key: 'userId', header: 'User ID', cellClassName: 'mono text-xs text-[var(--ink-mute)]' },
    { key: 'actions', header: 'Actions', align: 'right' as const },
  ]
}

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
  const game = useCurrentGame()
  // The admin channel decides which actions exist; the API gates the same
  // way, so a hidden button here is a 404 there rather than a silent no-op.
  const can = game
    ? playerAdminFeatures(game)
    : { list: true, kick: true, ban: true, unban: true, announce: true, save: true }
  const players = data?.players ?? []
  const columns = columnsFor(game)
  const showLevel = columns.some((c) => c.key === 'level')
  const showPing = columns.some((c) => c.key === 'ping')

  return (
    <div className="cmd-wide space-y-6">
      <div className="pg-head">
        <h1>Players</h1>
      </div>

      {can.announce && (
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
      )}

      <Card
        title="Players"
        {...(can.announce ? {} : { actions: <span className="meta">{data ? `${players.length} online` : ''}</span> })}
      >
        {offline ? (
          <p className="cmd-empty">Server is offline — player list unavailable.</p>
        ) : (
          <DataTable
            columns={columns}
            empty="No players online."
            rows={players.map((p) => ({
              id: p.userId,
              cells: [
                <span className="font-medium">{p.name}</span>,
                ...(showLevel ? [p.level ?? '—'] : []),
                ...(showPing
                  ? [
                      p.ping === undefined ? (
                        '—'
                      ) : (
                        <Badge tone={p.ping < 80 ? 'good' : 'warn'}>{p.ping} ms</Badge>
                      ),
                    ]
                  : []),
                p.userId,
                <div className="flex justify-end gap-2">
                  {can.kick && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === p.userId}
                      onClick={() => act(() => api.kick(p.userId), p.userId)}
                    >
                      Kick
                    </Button>
                  )}
                  {can.ban && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy === p.userId}
                      onClick={() => act(() => api.ban(p.userId), p.userId)}
                    >
                      Ban
                    </Button>
                  )}
                </div>,
              ],
            }))}
          />
        )}
      </Card>
    </div>
  )
}
