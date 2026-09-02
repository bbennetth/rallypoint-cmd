import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, TestClient, type TestApp } from '../../test/http.js'

let t: TestApp

afterEach(() => t?.close())

// The login limiter is the only unauthenticated brute-force defence. With
// TRUSTED_PROXY it keys on X-Forwarded-For; an append-style proxy puts the
// real peer LAST, so the first entry is whatever the client sent.
describe('login rate limit behind a trusted proxy', () => {
  it('cannot be bypassed by rotating the client-supplied X-Forwarded-For entry', async () => {
    t = await createTestApp({ env: { TRUSTED_PROXY: true } })
    const client = new TestClient(t.app, t.env)
    await client.csrf()

    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const res = await client.request('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'wrong' },
        // Attacker rotates the first hop; the proxy appended the real peer.
        headers: { 'x-forwarded-for': `10.${i}.0.1, 203.0.113.9` },
      })
      statuses.push(res.status)
      if (res.status === 429) {
        const body = (await res.json()) as { error: { code: string } }
        expect(body.error.code).toBe('rate_limited')
        break
      }
    }
    expect(statuses).toContain(429)
  })

  it('keys on the proxy-appended hop, so distinct clients get distinct buckets', async () => {
    t = await createTestApp({ env: { TRUSTED_PROXY: true } })
    const client = new TestClient(t.app, t.env)
    await client.csrf()

    for (let i = 0; i < 12; i++) {
      const res = await client.request('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'wrong' },
        headers: { 'x-forwarded-for': `198.51.100.7, 10.${i}.0.1` },
      })
      expect(res.status).toBe(401)
    }
  })
})
