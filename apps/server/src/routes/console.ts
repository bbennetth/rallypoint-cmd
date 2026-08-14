import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'

const HEARTBEAT_MS = 15_000

export const consoleRoutes = new Hono<HonoApp>()

// Live console: replay the journal ring buffer, then stream lines as
// they arrive. Subscribe-only — the singleton tailer is shared across
// every viewer. Heartbeats keep Cloudflare's ~100s idle timeout at bay.
consoleRoutes.get('/console/stream', requireSession, (c) => {
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const { journal } = c.get('services')

    let id = 0
    for (const line of journal.buffer()) {
      await stream.writeSSE({ event: 'log', data: line, id: String(id++) })
    }
    const unsubscribe = journal.subscribe((line) => {
      void stream.writeSSE({ event: 'log', data: line, id: String(id++) })
    })
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' })
    }, HEARTBEAT_MS)

    stream.onAbort(() => {
      unsubscribe()
      clearInterval(heartbeat)
    })
    // Hold the stream open until the client disconnects.
    await new Promise<void>((resolve) => stream.onAbort(resolve))
  })
})
