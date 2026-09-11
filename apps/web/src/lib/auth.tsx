import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { SessionInfo } from '@rallypoint-cmd/shared'
import { api, ApiError, resetCsrf } from './api.js'

interface AuthState {
  session: SessionInfo | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setSession(await api.session())
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    setSession(await api.login(username, password))
  }, [])

  // The local session goes regardless of what the server says: an
  // expired cookie (401), a stale CSRF token (403) or a 500 all used to
  // throw before setSession(null) ran, leaving the user apparently signed
  // in on a page whose every request fails.
  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setSession(null)
      resetCsrf()
    }
  }, [])

  return (
    <AuthContext.Provider value={{ session, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
