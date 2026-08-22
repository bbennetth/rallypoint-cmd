import { useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { useSseLines } from '../lib/useEventSource.js'
import { apiScope } from '../lib/api.js'
import { useCurrentGame } from '../lib/useCurrentGame.js'
import { Badge, Button, inputClass } from '../ui/primitives.js'
import { Banner } from '../ui/Banner.js'
import { LogPane } from '../ui/LogPane.js'

export function ConsolePage() {
  const { lines, connected, clear } = useSseLines(`${apiScope()}/console/stream`, 'log', { max: 2000 })
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [autoscroll, setAutoscroll] = useState(true)
  // Broadcast needs an admin/query API; hide it for games without one.
  const game = useCurrentGame()
  const canAnnounce = game ? game.capabilities.query === 'pal-rest' : false

  async function announce(e: React.FormEvent) {
    e.preventDefault()
    if (!message.trim()) return
    setSending(true)
    setErr(null)
    try {
      await api.announce(message.trim())
      setMessage('')
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Failed to broadcast')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="cmd-fill gap-3">
      <div className="pg-head">
        <div className="flex items-center gap-3">
          <h1>Live console</h1>
          <Badge tone={connected ? 'good' : 'muted'}>{connected ? 'streaming' : 'connecting…'}</Badge>
        </div>
        <div className="flex items-center gap-4">
          <label className="eyebrow flex cursor-pointer items-center gap-2">
            <input
              className="cyber-checkbox"
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>

      <LogPane
        lines={lines}
        fill
        autoscroll={autoscroll}
        empty="Waiting for journal output…"
      />

      {canAnnounce && (
      <form onSubmit={announce} className="flex gap-2">
        <input
          className={inputClass}
          placeholder="Broadcast a message to all players…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <Button variant="primary" className="grow" disabled={sending || !message.trim()}>
          Broadcast
        </Button>
      </form>
      )}
      {err && <Banner tone="bad">{err}</Banner>}
    </div>
  )
}
