import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { GameServerSummary } from '@rallypoint-cmd/shared'
import { api } from './api.js'
import { useAuth } from './auth.js'
import { usePoll } from './usePoll.js'

// The registered servers, fetched once for the whole app.
//
// GET /api/servers is global, not per-page, but four call sites used to
// fetch it independently — the chrome (for the capability-gated nav),
// useCurrentGame (once per page that calls it, twice on the Dashboard),
// Management and the server list. Landing on a server's dashboard fired
// three identical requests, each of which runs `systemctl status` plus a
// build-id probe per instance server-side.
//
// Only the server list needs it live. `useServersLive()` registers that
// interest; while at least one component holds it the context polls, and
// otherwise it is a single fetch per sign-in.

const POLL_MS = 5000

interface ServersState {
  servers: readonly GameServerSummary[] | null
  error: Error | null
  loading: boolean
  refresh: () => Promise<void>
  /** @internal — `useServersLive` registers through these. */
  addWatcher: () => void
  removeWatcher: () => void
}

const ServersContext = createContext<ServersState | null>(null)

export function ServersProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [watchers, setWatchers] = useState(0)

  const { data, error, loading, refresh } = usePoll(api.servers, watchers > 0 ? POLL_MS : null, {
    enabled: session != null,
  })

  const addWatcher = useCallback(() => setWatchers((n) => n + 1), [])
  const removeWatcher = useCallback(() => setWatchers((n) => Math.max(0, n - 1)), [])

  return (
    <ServersContext.Provider
      value={{
        servers: data?.servers ?? null,
        error,
        loading,
        refresh,
        addWatcher,
        removeWatcher,
      }}
    >
      {children}
    </ServersContext.Provider>
  )
}

export function useServers(): ServersState {
  const ctx = useContext(ServersContext)
  if (!ctx) throw new Error('useServers must be used within ServersProvider')
  return ctx
}

// Opt the context into polling while this component is mounted. `enabled`
// is the same pause the server list already wanted: a poll result
// re-renders a dialog's controlled <select>, and desktop Chrome closes
// its open picker when that happens underneath it.
export function useServersLive(enabled = true): void {
  const { addWatcher, removeWatcher } = useServers()
  useEffect(() => {
    if (!enabled) return
    addWatcher()
    return removeWatcher
  }, [enabled, addWatcher, removeWatcher])
}
