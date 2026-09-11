import { apiScope } from './api.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { longOpSchema, type LongOp } from '@rallypoint-cmd/shared'

// EventSource reconnects on its own, but it cannot tell you whether it
// gave up: `error` fires both while retrying and after a permanent
// failure (a 401, a 404, a non-event-stream body). readyState is the only
// way to tell, so every hook here reports it.
export type SseStatus = 'connecting' | 'open' | 'closed'

const LONG_OP_LINE_MAX = 2000

// Open an SSE stream and hand each named event to `onEvent`. `enabled`
// lets callers pause it (e.g. only stream while an op is running).
//
// Both panel streams replay their whole ring buffer on connect, so
// `onReset` fires on every (re)open: the replay is authoritative, and
// appending to what we already had duplicated the entire log on each
// reconnect.
function useSseSubscription(
  url: string,
  enabled: boolean,
  events: readonly string[],
  onEvent: (name: string, data: string) => void,
  onReset: () => void,
): { status: SseStatus; retry: () => void } {
  const [status, setStatus] = useState<SseStatus>('connecting')
  const [nonce, setNonce] = useState(0)
  // Held in refs so a caller need not memoise them to avoid reconnecting.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onResetRef = useRef(onReset)
  onResetRef.current = onReset
  // Joined so the event list is a stable dependency: callers pass an
  // array literal, which is a new identity on every render.
  const key = events.join(',')

  useEffect(() => {
    setStatus('connecting')
    if (!enabled) return
    const es = new EventSource(url, { withCredentials: true })
    es.onopen = () => {
      onResetRef.current()
      setStatus('open')
    }
    es.onerror = () => {
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
    }
    const listeners = key.split(',').map((name) => {
      const fn = (ev: Event): void => onEventRef.current(name, (ev as MessageEvent).data as string)
      es.addEventListener(name, fn)
      return [name, fn] as const
    })
    return () => {
      for (const [name, fn] of listeners) es.removeEventListener(name, fn)
      es.close()
    }
  }, [url, enabled, key, nonce])

  // Forces a fresh EventSource; the browser will not retry one it closed.
  const retry = useCallback(() => setNonce((n) => n + 1), [])

  return { status, retry }
}

// Subscribe to an SSE endpoint. Buffers the last `max` lines of a given
// event name. Auto-reconnects (EventSource does this natively). `enabled`
// lets callers pause the stream (e.g. only stream the console tab when open).
export function useSseLines(
  url: string,
  eventName: string,
  opts: { enabled?: boolean; max?: number } = {},
): { lines: string[]; connected: boolean; status: SseStatus; clear: () => void; retry: () => void } {
  const { enabled = true, max = 1000 } = opts
  const [lines, setLines] = useState<string[]>([])
  const bufferRef = useRef<string[]>([])

  const clear = useCallback(() => {
    bufferRef.current = []
    setLines([])
  }, [])

  const { status, retry } = useSseSubscription(
    url,
    enabled,
    [eventName],
    (_name, data) => {
      const next = [...bufferRef.current, data]
      if (next.length > max) next.splice(0, next.length - max)
      bufferRef.current = next
      setLines(next)
    },
    clear,
  )

  return { lines, connected: status === 'open', status, clear, retry }
}

// Follow a running long-op over an SSE stream: progress pct, the log
// lines, and — crucially — the op's final status and error (the `done`
// event carries the full LongOp as JSON). This is what surfaces
// server-side backup/restore/steamcmd failures in the UI instead of
// letting them die silently. Defaults to the current server's updates
// stream; pass a url for a panel-scoped op stream (e.g. /api/panel/stream).
export function useLongOp(
  enabled: boolean,
  url?: string,
): {
  progress: number | null
  lastLine: string | null
  lines: string[]
  doneOp: LongOp | null
  status: SseStatus
  reset: () => void
  retry: () => void
} {
  const [progress, setProgress] = useState<number | null>(null)
  const [lastLine, setLastLine] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [doneOp, setDoneOp] = useState<LongOp | null>(null)
  const bufferRef = useRef<string[]>([])

  const reset = useCallback(() => {
    bufferRef.current = []
    setProgress(null)
    setLastLine(null)
    setLines([])
    setDoneOp(null)
  }, [])

  // Drops the replayed backlog but keeps the op verdict: `done` can
  // arrive before `open` on a reconnect, and losing it would strand the
  // caller exactly like the race below.
  const onReset = useCallback(() => {
    bufferRef.current = []
    setLines([])
  }, [])

  const { status, retry } = useSseSubscription(
    url ?? `${apiScope()}/updates/stream`,
    enabled,
    ['log', 'progress', 'done', 'op'],
    (name, data) => {
      if (name === 'progress') {
        setProgress(Number(data))
        return
      }
      if (name === 'log') {
        setLastLine(data)
        const next = [...bufferRef.current, data]
        if (next.length > LONG_OP_LINE_MAX) next.splice(0, next.length - LONG_OP_LINE_MAX)
        bufferRef.current = next
        setLines(next)
        return
      }
      try {
        const op = longOpSchema.parse(JSON.parse(data))
        // `op` is the on-connect replay of the current op. A fast op can
        // finish BEFORE the EventSource connects — its `done` event is
        // gone, and the replay is the only signal. Treat any non-running
        // replayed op as terminal, otherwise the UI spins forever.
        if (name === 'done' || op.status !== 'running') setDoneOp(op)
      } catch {
        // ignore unparseable frames
      }
    },
    onReset,
  )

  return { progress, lastLine, lines, doneOp, status, reset, retry }
}
