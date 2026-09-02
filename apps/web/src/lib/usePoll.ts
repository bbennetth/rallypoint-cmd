import { useCallback, useEffect, useRef, useState } from 'react'

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
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean } = {},
): { data: T | null; error: Error | null; loading: boolean; refresh: () => Promise<void> } {
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

  useEffect(() => {
    if (!enabled) return
    let active = true
    void refresh()
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
