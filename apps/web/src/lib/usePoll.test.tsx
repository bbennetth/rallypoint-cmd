// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAsyncData, usePoll } from './usePoll.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Only the timer APIs — faking queueMicrotask/nextTick as well stalls
// React's scheduler, so effects never flush.
const TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const

function useTimers(): void {
  vi.useFakeTimers({ toFake: [...TIMERS] })
}

describe('useAsyncData', () => {
  it('fetches once and never polls', async () => {
    useTimers()
    const fetcher = vi.fn(() => Promise.resolve({ n: 1 }))
    const { result } = renderHook(() => useAsyncData(fetcher))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a rejection instead of loading forever', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('capability_unsupported')))
    const { result } = renderHook(() => useAsyncData(fetcher))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error?.message).toBe('capability_unsupported')
    expect(result.current.data).toBeNull()
  })

  it('refetches on refresh() and clears a previous error', async () => {
    let attempt = 0
    const fetcher = vi.fn(() =>
      ++attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ n: attempt }),
    )
    const { result } = renderHook(() => useAsyncData(fetcher))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual({ n: 2 })
  })

  it('keeps the last good value when a later fetch fails', async () => {
    let attempt = 0
    const fetcher = vi.fn(() =>
      ++attempt === 1 ? Promise.resolve({ n: 1 }) : Promise.reject(new Error('gone')),
    )
    const { result } = renderHook(() => useAsyncData(fetcher))

    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error?.message).toBe('gone')
    expect(result.current.data).toEqual({ n: 1 })
  })

  it('lets a newer response win over a slower older one', async () => {
    // The first call resolves last. Without the sequence guard it would
    // clobber the fresher value — a stale `systemctl status` overwriting
    // the state after a stop.
    const pending: ((v: { n: number }) => void)[] = []
    const fetcher = vi.fn(() => new Promise<{ n: number }>((resolve) => pending.push(resolve)))
    const { result } = renderHook(() => useAsyncData(fetcher))

    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => {
      void result.current.refresh()
    })
    expect(pending).toHaveLength(2)

    await act(async () => {
      pending[1]?.({ n: 2 })
      pending[0]?.({ n: 1 })
      await Promise.resolve()
    })
    expect(result.current.data).toEqual({ n: 2 })
  })
})

describe('usePoll', () => {
  it('polls on the interval', async () => {
    useTimers()
    const fetcher = vi.fn(() => Promise.resolve({ n: 1 }))
    renderHook(() => usePoll(fetcher, 5000))

    await act(async () => {
      await Promise.resolve()
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not refetch when only the interval changes', async () => {
    useTimers()
    const fetcher = vi.fn(() => Promise.resolve({ n: 1 }))
    // What the servers context does when the list stops needing to be
    // live: a stray fetch here re-renders an open dialog's <select> and
    // desktop Chrome closes the picker under the user.
    const { rerender } = renderHook(({ ms }: { ms: number | null }) => usePoll(fetcher, ms), {
      initialProps: { ms: 5000 as number | null },
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    rerender({ ms: null })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not fetch while disabled', async () => {
    const fetcher = vi.fn(() => Promise.resolve({ n: 1 }))
    renderHook(() => usePoll(fetcher, 5000, { enabled: false }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
