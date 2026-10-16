import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SessionInfo } from '@rallypoint-cmd/shared'
import { api, ApiError, resetCsrf } from './api.js'

// Three answers, not two. A 401 means signed out; anything else — the
// panel restarting, a proxy 502, a schema drift throwing a ZodError out
// of api.session() — means we simply do not know yet. Collapsing the
// second into the first signed people out of a perfectly good session.
export type AuthStatus = 'loading' | 'authed' | 'anon' | 'error'

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

interface AuthState {
  session: SessionInfo | null
  status: AuthStatus
  /** True until the first definitive answer. */
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempts = useRef(0)

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [])

  const refresh = useCallback(async () => {
    clearRetry()
    try {
      setSession(await api.session())
      setStatus('authed')
      attempts.current = 0
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession(null)
        setStatus('anon')
        attempts.current = 0
        return
      }
      // Keep whatever session we had — the cookie is probably still good,
      // the panel just is not answering — and keep trying.
      setStatus('error')
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempts.current, RETRY_MAX_MS)
      attempts.current += 1
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null
        void refreshRef.current()
      }, delay)
    }
  }, [clearRetry])
  // Re-entry through a ref rather than a self-referencing dependency, the
  // same way usePoll holds its fetcher.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    void refresh()
    return clearRetry
  }, [refresh, clearRetry])

  const login = useCallback(async (username: string, password: string) => {
    setSession(await api.login(username, password))
    setStatus('authed')
  }, [])

  // The local session goes regardless of what the server says: an
  // expired cookie (401), a stale CSRF token (403) or a 500 all used to
  // throw before setSession(null) ran, leaving the user apparently signed
  // in on a page whose every request fails.
  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      clearRetry()
      attempts.current = 0
      setSession(null)
      setStatus('anon')
      resetCsrf()
    }
  }, [clearRetry])

  return (
    <AuthContext.Provider
      value={{ session, status, loading: status === 'loading', login, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
