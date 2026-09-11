// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { LongOp } from '@rallypoint-cmd/shared'
import { FakeEventSource } from './test-sse.js'
import { useLongOp, useSseLines } from './useEventSource.js'

function op(overrides: Partial<LongOp> = {}): LongOp {
  return {
    id: '01JABCDEFGHJKMNPQRSTVWXYZ',
    kind: 'install',
    status: 'running',
    startedAtMs: 1,
    finishedAtMs: null,
    progressPct: null,
    error: null,
    ...overrides,
  }
}

beforeEach(() => FakeEventSource.install())
afterEach(cleanup)

describe('useSseLines', () => {
  it('does not duplicate the log when the stream reconnects', () => {
    const { result } = renderHook(() => useSseLines('/api/console/stream', 'log'))
    const es = FakeEventSource.last

    // First connect: the server replays its ring buffer.
    act(() => {
      es.open()
      es.emit('log', 'one')
      es.emit('log', 'two')
    })
    expect(result.current.lines).toEqual(['one', 'two'])

    // The connection drops and comes back. The server replays the same
    // backlog from the top and ignores Last-Event-ID, so the replay — not
    // what we already had — is the truth.
    act(() => {
      es.drop()
      es.open()
      es.emit('log', 'one')
      es.emit('log', 'two')
      es.emit('log', 'three')
    })
    expect(result.current.lines).toEqual(['one', 'two', 'three'])
  })

  it('reports a stream the browser gave up on as closed, not connecting', () => {
    const { result } = renderHook(() => useSseLines('/api/console/stream', 'log'))
    const es = FakeEventSource.last
    expect(result.current.status).toBe('connecting')

    act(() => es.open())
    expect(result.current.status).toBe('open')
    expect(result.current.connected).toBe(true)

    // A retryable drop still reads as connecting…
    act(() => es.drop())
    expect(result.current.status).toBe('connecting')

    // …but a 401 closes the EventSource for good.
    act(() => es.fail())
    expect(result.current.status).toBe('closed')
    expect(result.current.connected).toBe(false)
  })

  it('reconnects on retry(), since the browser will not', () => {
    const { result } = renderHook(() => useSseLines('/api/console/stream', 'log'))
    act(() => FakeEventSource.last.fail())
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => result.current.retry())
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(result.current.status).toBe('connecting')
    act(() => FakeEventSource.last.open())
    expect(result.current.status).toBe('open')
  })

  it('caps the buffer at `max`', () => {
    const { result } = renderHook(() => useSseLines('/api/console/stream', 'log', { max: 2 }))
    act(() => {
      FakeEventSource.last.open()
      for (const l of ['a', 'b', 'c']) FakeEventSource.last.emit('log', l)
    })
    expect(result.current.lines).toEqual(['b', 'c'])
  })

  it('keeps a stable clear() identity across renders', () => {
    const { result, rerender } = renderHook(() => useSseLines('/api/console/stream', 'log'))
    const first = result.current.clear
    rerender()
    expect(result.current.clear).toBe(first)
  })

  it('opens no stream while disabled', () => {
    renderHook(() => useSseLines('/api/console/stream', 'log', { enabled: false }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('useLongOp', () => {
  it('treats a finished op replayed on connect as terminal', () => {
    // The race: the op completes between GET /updates and the
    // EventSource connecting, so its `done` event is gone and the
    // on-connect `op` replay is the only signal left.
    const { result } = renderHook(() => useLongOp(true))
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('op', JSON.stringify(op({ status: 'succeeded', finishedAtMs: 2 })))
    })
    expect(result.current.doneOp?.status).toBe('succeeded')
  })

  it('does not treat a still-running replayed op as terminal', () => {
    const { result } = renderHook(() => useLongOp(true))
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('op', JSON.stringify(op()))
    })
    expect(result.current.doneOp).toBeNull()
  })

  it('resolves on the done event and carries the failure through', () => {
    const { result } = renderHook(() => useLongOp(true))
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit(
        'done',
        JSON.stringify(op({ status: 'failed', error: 'disk full', finishedAtMs: 2 })),
      )
    })
    expect(result.current.doneOp?.status).toBe('failed')
    expect(result.current.doneOp?.error).toBe('disk full')
  })

  it('collects log lines and progress, and drops the replay on reconnect', () => {
    const { result } = renderHook(() => useLongOp(true))
    const es = FakeEventSource.last
    act(() => {
      es.open()
      es.emit('log', 'downloading')
      es.emit('progress', '42.5')
    })
    expect(result.current.lines).toEqual(['downloading'])
    expect(result.current.lastLine).toBe('downloading')
    expect(result.current.progress).toBe(42.5)

    act(() => {
      es.drop()
      es.open()
      es.emit('log', 'downloading')
      es.emit('log', 'verifying')
    })
    expect(result.current.lines).toEqual(['downloading', 'verifying'])
  })

  it('keeps the verdict when a reconnect clears the backlog', () => {
    // `done` can land before `open` on a reconnect; losing it there would
    // strand the caller exactly like the replay race above.
    const { result } = renderHook(() => useLongOp(true))
    const es = FakeEventSource.last
    act(() => {
      es.open()
      es.emit('done', JSON.stringify(op({ status: 'succeeded', finishedAtMs: 2 })))
    })
    act(() => {
      es.drop()
      es.open()
    })
    expect(result.current.doneOp?.status).toBe('succeeded')
  })

  it('ignores unparseable frames', () => {
    const { result } = renderHook(() => useLongOp(true))
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('done', 'not json')
      FakeEventSource.last.emit('op', '{"kind":"nope"}')
    })
    expect(result.current.doneOp).toBeNull()
  })

  it('keeps a stable reset() identity across renders', () => {
    const { result, rerender } = renderHook(() => useLongOp(true))
    const first = result.current.reset
    rerender()
    expect(result.current.reset).toBe(first)
  })

  it('clears everything on reset()', () => {
    const { result } = renderHook(() => useLongOp(true))
    act(() => {
      FakeEventSource.last.open()
      FakeEventSource.last.emit('log', 'line')
      FakeEventSource.last.emit('progress', '10')
      FakeEventSource.last.emit('done', JSON.stringify(op({ status: 'succeeded' })))
    })
    act(() => result.current.reset())
    expect(result.current.lines).toEqual([])
    expect(result.current.lastLine).toBeNull()
    expect(result.current.progress).toBeNull()
    expect(result.current.doneOp).toBeNull()
  })
})
