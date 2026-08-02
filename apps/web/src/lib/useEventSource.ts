import { useEffect, useRef, useState } from 'react'
import { longOpSchema, type LongOp } from '@rallypoint-cmd/shared'

// Subscribe to an SSE endpoint. Buffers the last `max` lines of a given
// event name. Auto-reconnects (EventSource does this natively). `enabled`
// lets callers pause the stream (e.g. only stream the console tab when open).
export function useSseLines(
  url: string,
  eventName: string,
  opts: { enabled?: boolean; max?: number } = {},
): { lines: string[]; connected: boolean; clear: () => void } {
  const { enabled = true, max = 1000 } = opts
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const bufferRef = useRef<string[]>([])

  useEffect(() => {
    if (!enabled) return
    const es = new EventSource(url, { withCredentials: true })
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.addEventListener(eventName, (ev) => {
      const data = (ev as MessageEvent).data as string
      const next = [...bufferRef.current, data]
      if (next.length > max) next.splice(0, next.length - max)
      bufferRef.current = next
      setLines(next)
    })
    return () => es.close()
  }, [url, eventName, enabled, max])

  return {
    lines,
    connected,
    clear: () => {
      bufferRef.current = []
      setLines([])
    },
  }
}

// Generic multi-event SSE subscription for the updates stream (log +
// progress + done). Returns the latest of each.
export function useSseUpdates(url: string, enabled: boolean) {
  const [log, setLog] = useState<string[]>([])
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const bufRef = useRef<string[]>([])

  useEffect(() => {
    if (!enabled) return
    setDone(null)
    const es = new EventSource(url, { withCredentials: true })
    const onLog = (ev: MessageEvent) => {
      const next = [...bufRef.current, ev.data as string]
      if (next.length > 2000) next.splice(0, next.length - 2000)
      bufRef.current = next
      setLog(next)
    }
    es.addEventListener('log', onLog as EventListener)
    es.addEventListener('progress', (ev) => setProgress(Number((ev as MessageEvent).data)))
    es.addEventListener('done', (ev) => setDone((ev as MessageEvent).data as string))
    return () => es.close()
  }, [url, enabled])

  return { log, progress, done, reset: () => {
    bufRef.current = []
    setLog([])
    setProgress(null)
    setDone(null)
  } }
}

// Follow a running long-op over the shared /api/updates/stream SSE:
// progress pct, latest log line, and — crucially — the op's final status
// and error (the `done` event carries the full LongOp as JSON). This is
// what surfaces server-side backup/restore failures in the UI instead of
// letting them die silently.
export function useLongOp(enabled: boolean): {
  progress: number | null
  lastLine: string | null
  doneOp: LongOp | null
  reset: () => void
} {
  const [progress, setProgress] = useState<number | null>(null)
  const [lastLine, setLastLine] = useState<string | null>(null)
  const [doneOp, setDoneOp] = useState<LongOp | null>(null)

  useEffect(() => {
    if (!enabled) return
    setDoneOp(null)
    const es = new EventSource('/api/updates/stream', { withCredentials: true })
    const finish = (ev: Event): void => {
      try {
        const op = longOpSchema.parse(JSON.parse((ev as MessageEvent).data as string))
        // `op` is the on-connect replay of the current op. A fast op can
        // finish BEFORE the EventSource connects — its `done` event is
        // gone, and the replay is the only signal. Treat any non-running
        // replayed op as terminal, otherwise the UI spins forever.
        if (op.status !== 'running') setDoneOp(op)
      } catch {
        // ignore unparseable frames
      }
    }
    es.addEventListener('log', (ev) => setLastLine((ev as MessageEvent).data as string))
    es.addEventListener('progress', (ev) => setProgress(Number((ev as MessageEvent).data)))
    es.addEventListener('done', finish)
    es.addEventListener('op', finish)
    return () => es.close()
  }, [enabled])

  return {
    progress,
    lastLine,
    doneOp,
    reset: () => {
      setProgress(null)
      setLastLine(null)
      setDoneOp(null)
    },
  }
}
