import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { LongOp } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import type { LongOpRunner } from '../services/long-op.js'

const HEARTBEAT_MS = 15_000

// Shared SSE progress stream for a LongOpRunner: replays the current op +
// its line buffer, then streams live lines, progress percentages, and the
// terminal `done` event. Used by both the per-server updates stream
// (instance longOps) and the panel stream (panel-level longOps).
export function streamLongOp(c: Context<HonoApp>, longOps: LongOpRunner): Response {
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const current = longOps.current()
    if (current) {
      await stream.writeSSE({ event: 'op', data: JSON.stringify(current) })
    }
    for (const line of longOps.buffer()) {
      await stream.writeSSE({ event: 'log', data: line })
    }

    const unsubLine = longOps.subscribe('line', (line) => {
      void stream.writeSSE({ event: 'log', data: String(line) })
    })
    const unsubProgress = longOps.subscribe('progress', (pct) => {
      void stream.writeSSE({ event: 'progress', data: String(pct) })
    })
    const unsubDone = longOps.subscribe('done', (op) => {
      void stream.writeSSE({ event: 'done', data: JSON.stringify(op as LongOp) })
    })
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' })
    }, HEARTBEAT_MS)

    stream.onAbort(() => {
      unsubLine()
      unsubProgress()
      unsubDone()
      clearInterval(heartbeat)
    })
    await new Promise<void>((resolve) => stream.onAbort(resolve))
  })
}
