// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth.js'
import { ApiError } from './api.js'

const session = vi.fn()
const logout = vi.fn()

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js')
  return {
    ...actual,
    resetCsrf: vi.fn(),
    api: {
      session: () => session() as Promise<unknown>,
      logout: () => logout() as Promise<unknown>,
      login: () => Promise.resolve({ username: 'admin' }),
    },
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

beforeEach(() => {
  session.mockReset()
  logout.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AuthProvider', () => {
  it('reports a signed-in session', async () => {
    session.mockResolvedValue({ username: 'admin' })
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('authed'))
    expect(result.current.session).toEqual({ username: 'admin' })
  })

  it('treats a 401 as signed out', async () => {
    session.mockRejectedValue(new ApiError('unauthorized', 'nope', 401))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('anon'))
    expect(result.current.session).toBeNull()
  })

  it('treats a 502 as unknown, not signed out', async () => {
    // The panel restarting or a proxy hiccup used to read as "signed out"
    // and bounce the user to /login with a perfectly good cookie.
    session.mockRejectedValue(new ApiError('bad_gateway', 'upstream', 502))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.status).not.toBe('anon')
  })

  it('treats a non-ApiError (a schema drift) as unknown too', async () => {
    // api.ts parses the success body unguarded, so a drifted schema
    // throws a ZodError — not something `err instanceof ApiError` catches.
    session.mockRejectedValue(new TypeError('invalid_type at .username'))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('keeps an established session through a transient failure', async () => {
    session.mockResolvedValueOnce({ username: 'admin' })
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authed'))

    session.mockRejectedValue(new ApiError('bad_gateway', 'upstream', 502))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.status).toBe('error')
    expect(result.current.session).toEqual({ username: 'admin' })
  })

  it('retries with backoff and recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    session.mockRejectedValueOnce(new ApiError('bad_gateway', 'upstream', 502))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status).toBe('error')

    session.mockResolvedValue({ username: 'admin' })
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(result.current.status).toBe('authed')
  })

  it('clears the session even when the logout request fails', async () => {
    // POST /auth/logout sits behind requireSession, so logging out with an
    // already-expired cookie 401s — which used to skip setSession(null)
    // and leave the user apparently signed in.
    session.mockResolvedValue({ username: 'admin' })
    logout.mockRejectedValue(new ApiError('unauthorized', 'nope', 401))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('authed'))

    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow()
    })
    expect(result.current.session).toBeNull()
    expect(result.current.status).toBe('anon')
  })
})
