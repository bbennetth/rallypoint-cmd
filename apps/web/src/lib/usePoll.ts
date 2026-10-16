import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollResult<T> {
  data: T | null
  error: Error | null
  loading: boolean
  refresh: () => Promise<void>
}

// Poll an async fetcher on an interval, with manual refresh. Keeps the
// last good value while refetching so the UI doesn't flicker.
//
// Ordering: every call takes a sequence number and only the newest one
// may commit, so a slow response (systemctl hanging mid-stop) cannot
// overwrite a fresher one. Interval ticks skip while a call is in flight;
// a manual `refresh()` always runs, it just cannot lose to an older call.
//
// `enabled: false` pauses the interval without dropping the last value.
// Pages use it while a dialog is open: re-rendering a controlled <select>
// re-applies its selection, and desktop Chrome closes an open picker
// when that happens under it.
//
// `intervalMs: null` fetches once and never polls — see `useAsyncData`.
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number | null,
  opts: { enabled?: boolean } = {},
): PollResult<T> {
  const enabled = opts.enabled ?? true
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const seq = useRef(0)
  const inFlight = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    inFlight.current += 1
    try {
      const next = await fetcherRef.current()
      if (mine === seq.current) {
        setData(next)
        setError(null)
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      inFlight.current -= 1
      setLoading(false)
    }
  }, [])

  // The initial fetch and the interval are separate effects on purpose:
  // a caller that only changes `intervalMs` (the servers context turning
  // polling on and off) must not fire an extra fetch, which would
  // re-render a dialog's controlled <select> out from under the user.
  useEffect(() => {
    if (!enabled) return
    void refresh()
  }, [refresh, enabled])

  useEffect(() => {
    if (!enabled || intervalMs == null) return
    let active = true
    const t = setInterval(() => {
      if (active && inFlight.current === 0) void refresh()
    }, intervalMs)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [refresh, intervalMs, enabled])

  return { data, error, loading, refresh }
}

// One-shot load with the same {data, error, loading, refresh} shape —
// `usePoll` minus the interval. Pages use it for the data they fetch on
// mount so a rejected request surfaces as an error banner instead of a
// permanent "Loading…".
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  opts: { enabled?: boolean } = {},
): PollResult<T> {
  return usePoll(fetcher, null, opts)
}
