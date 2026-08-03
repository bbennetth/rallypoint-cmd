import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api.js'
import { useSseLines } from '../lib/useEventSource.js'
import { Badge, Button, inputClass } from '../ui/primitives.js'

export function ConsolePage() {
  const { lines, connected, clear } = useSseLines('/api/console/stream', 'log', { max: 2000 })
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [autoscroll, setAutoscroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [lines, autoscroll])

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Live console</h1>
          <Badge tone={connected ? 'good' : 'muted'}>{connected ? 'streaming' : 'connecting…'}</Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-panel-muted">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <Button variant="ghost" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>

      <div className="thin-scroll flex-1 overflow-auto rounded-xl border border-panel-border bg-black/40 p-3">
        <pre className="mono whitespace-pre-wrap break-words text-xs leading-relaxed text-panel-text/90">
          {lines.length === 0 ? (
            <span className="text-panel-muted">Waiting for journal output…</span>
          ) : (
            lines.join('\n')
          )}
        </pre>
        <div ref={bottomRef} />
      </div>

      <form onSubmit={announce} className="flex gap-2">
        <input
          className={inputClass}
          placeholder="Broadcast a message to all players…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <Button variant="primary" disabled={sending || !message.trim()}>
          Broadcast
        </Button>
      </form>
      {err && <p className="text-xs text-panel-bad">{err}</p>}
    </div>
  )
}
