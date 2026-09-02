import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, TestClient, type TestApp } from '../../test/http.js'

let t: TestApp

afterEach(() => t?.close())

describe('POST /api/auth/logout', () => {
  for (const cookieSecure of [true, false]) {
    it(`clears the session cookie and revokes the session (COOKIE_SECURE=${cookieSecure})`, async () => {
      t = await createTestApp({ env: { COOKIE_SECURE: cookieSecure } })
      const client = new TestClient(t.app, t.env)
      await client.csrf()

      const login = await client.login()
      expect(login.status).toBe(200)
      const setAtLogin = login.headers.getSetCookie().find((c) => c.startsWith(`${t.env.SESSION_COOKIE_NAME}=`))
      expect(setAtLogin).toBeDefined()
      expect(/;\s*secure/i.test(setAtLogin!)).toBe(cookieSecure)
      expect((await client.request('GET', '/api/auth/session')).status).toBe(200)

      // Under COOKIE_SECURE the name is __Host-rp_session; hono refuses to
      // serialize a __Host- cookie without Secure, which used to turn this
      // into a 500 after the session row was already gone.
      const logout = await client.request('POST', '/api/auth/logout')
      expect(logout.status).toBe(200)
      expect(await logout.json()).toEqual({ ok: true })
      const cleared = logout.headers.getSetCookie().find((c) => c.startsWith(`${t.env.SESSION_COOKIE_NAME}=`))
      expect(cleared).toMatch(/max-age=0/i)
      expect(/;\s*secure/i.test(cleared!)).toBe(cookieSecure)
      expect(client.cookie(t.env.SESSION_COOKIE_NAME)).toBeUndefined()

      // Server side the session is revoked too.
      expect((await client.request('GET', '/api/auth/session')).status).toBe(401)
    })
  }
})
