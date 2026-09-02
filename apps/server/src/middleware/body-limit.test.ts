import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposedServices } from '../services/compose.js'
import { createTestApp, TestClient, type TestApp } from '../../test/http.js'
import { JSON_BODY_LIMIT_BYTES, SETTINGS_BODY_LIMIT_BYTES } from './body-limit.js'

let t: TestApp
let client: TestClient

// No instances: /api/servers/:id/* resolves to 404 AFTER the body limit
// ran, which is exactly what tells us whether the limit let a body through.
const noInstances = {
  instances: { get: () => undefined, list: () => [] },
} as unknown as ComposedServices

beforeEach(async () => {
  t = await createTestApp({ services: noInstances })
  client = new TestClient(t.app, t.env)
  await client.csrf()
})
afterEach(() => t.close())

function jsonOfSize(bytes: number): string {
  const body = { username: 'admin', password: '' }
  const overhead = JSON.stringify(body).length
  body.password = 'x'.repeat(Math.max(0, bytes - overhead))
  return JSON.stringify(body)
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 16 * 1024) controller.enqueue(bytes.subarray(i, i + 16 * 1024))
      controller.close()
    },
  })
}

async function codeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code: string } }
  return body.error?.code ?? 'ok'
}

describe('API body limit', () => {
  it('rejects an oversized JSON body up front (Content-Length)', async () => {
    const payload = jsonOfSize(JSON_BODY_LIMIT_BYTES + 1024)
    const res = await client.request('POST', '/api/auth/login', {
      body: payload,
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    })
    expect(res.status).toBe(413)
    expect(await codeOf(res)).toBe('payload_too_large')
  })

  it('rejects an oversized chunked body without a 2xx', async () => {
    const res = await client.request('POST', '/api/auth/login', {
      body: streamOf(jsonOfSize(JSON_BODY_LIMIT_BYTES + 1024)),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(413)
    expect(await codeOf(res)).toBe('payload_too_large')
  })

  it('leaves a normal login alone', async () => {
    const res = await client.login()
    expect(res.status).toBe(200)
  })

  it('gives the settings editor a larger ceiling', async () => {
    const big = JSON.stringify({ content: 'x'.repeat(1_000_000) })
    const res = await client.request('PUT', '/api/servers/nope/settings/raw', {
      body: big,
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
    })
    // Passed the limit, then the server resolver said 404 — not 413.
    expect(res.status).toBe(404)

    const huge = 'x'.repeat(SETTINGS_BODY_LIMIT_BYTES + 1)
    const over = await client.request('PUT', '/api/servers/nope/settings/raw', {
      body: huge,
      headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
    })
    expect(over.status).toBe(413)
  })

  it('exempts the streaming upload routes', async () => {
    const blob = 'x'.repeat(JSON_BODY_LIMIT_BYTES * 2)
    for (const route of ['/api/servers/nope/backups/upload', '/api/servers/nope/mods/upload?filename=a.pak']) {
      const res = await client.request('POST', route, {
        body: blob,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(blob.length) },
      })
      expect(res.status, route).toBe(404)
    }
  })
})
