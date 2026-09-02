import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Hono } from 'hono'
import type { PasswordHasher } from '../src/auth/password.js'
import { buildApp } from '../src/build-app.js'
import type { HonoApp } from '../src/context.js'
import { createDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import type { Env } from '../src/env.js'
import { buildLogger } from '../src/logger.js'
import { seedAdmin } from '../src/seed.js'
import type { ComposedServices } from '../src/services/compose.js'

// HTTP-level test harness: a real Hono app over a real (temp) SQLite db,
// driven through `app.request()` — no listening socket. Lives outside
// src/ so `tsc --build` never ships it; vitest picks it up through the
// *.test.ts files that import it.

export const TEST_PASSWORD = 'correct horse battery staple'

export function makeTestEnv(root: string, overrides: Partial<Env> = {}): Env {
  const cookieSecure = overrides.COOKIE_SECURE ?? false
  return {
    NODE_ENV: 'test',
    PANEL_MODE: 'mock',
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: 0,
    DATA_DIR: path.join(root, 'panel'),
    PANEL_BACKUP_DIR: path.join(root, 'backups'),
    GAMES_ROOT: path.join(root, 'games'),
    STEAMCMD_BIN: path.join(root, 'steamcmd.sh'),
    WEB_DIST_DIR: undefined,
    DB_PATH: path.join(root, 'panel', 'panel.sqlite'),
    PANEL_PASSWORD_PEPPER: 'test-pepper-0123456789abcdef',
    PANEL_PEPPER_VERSION: 1,
    PANEL_ADMIN_USERNAME: 'admin',
    PANEL_ADMIN_PASSWORD: TEST_PASSWORD,
    SESSION_TTL_DAYS: 30,
    COOKIE_SECURE: cookieSecure,
    // Mirrors env.ts: the __Host- prefix rides along with Secure.
    SESSION_COOKIE_NAME: cookieSecure ? '__Host-rp_session' : 'rp_session',
    CSRF_COOKIE_NAME: cookieSecure ? '__Host-rp_csrf' : 'rp_csrf',
    TRUSTED_PROXY: false,
    DISK_FLOOR_BYTES: 0,
    MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
    MAX_UNCOMPRESSED_BYTES: 100 * 1024 * 1024,
    PANEL_VERSION: '0.1.0-test',
    ...overrides,
  }
}

// Plain-text "hasher" so a test can log in hundreds of times without
// paying 32 MiB of scrypt per attempt. Never leaves the test tree.
export const fastHasher: PasswordHasher = {
  async hash(password) {
    return { secretHash: `plain$${password}`, keyVersion: 1 }
  },
  async verify(secretHash, _keyVersion, password) {
    return secretHash === `plain$${password}`
  },
  async dummyVerify() {},
}

export interface TestApp {
  app: Hono<HonoApp>
  env: Env
  root: string
  close(): void
}

export async function createTestApp(opts: {
  env?: Partial<Env>
  services?: Partial<ComposedServices>
} = {}): Promise<TestApp> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-http-test-'))
  const env = makeTestEnv(root, opts.env)
  const logger = buildLogger('error')
  const { db, sqlite } = createDb(env.DB_PATH)
  runMigrations(db)
  await seedAdmin(db, env, fastHasher, logger)
  const app = buildApp({
    env,
    logger,
    db,
    // Panel-scoped auth/csrf/rate-limit paths never touch `composed`; a
    // test that needs instances passes a real or stubbed bag.
    services: { ...(opts.services ?? {}) } as ComposedServices,
    passwordHasher: fastHasher,
  })
  return {
    app,
    env,
    root,
    close() {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
}

// Minimal cookie jar + CSRF echo, so tests read like a browser session:
// `await client.csrf(); await client.login(); await client.post(...)`.
export class TestClient {
  private readonly jar = new Map<string, string>()

  constructor(
    private readonly app: Hono<HonoApp>,
    private readonly env: Env,
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name)
  }

  async csrf(): Promise<string> {
    const res = await this.request('GET', '/api/csrf')
    const { token } = (await res.json()) as { token: string }
    return token
  }

  async login(username = this.env.PANEL_ADMIN_USERNAME, password = TEST_PASSWORD): Promise<Response> {
    return this.request('POST', '/api/auth/login', { body: { username, password } })
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(opts.headers ?? {})
    if (this.jar.size > 0) {
      headers.set('cookie', [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '))
    }
    const csrf = this.jar.get(this.env.CSRF_COOKIE_NAME)
    if (csrf && method !== 'GET' && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', csrf)
    }
    let body: BodyInit | undefined
    if (opts.body !== undefined) {
      if (typeof opts.body === 'string' || opts.body instanceof Uint8Array || opts.body instanceof ReadableStream) {
        body = opts.body as BodyInit
      } else {
        body = JSON.stringify(opts.body)
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      }
    }
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body }
    if (body instanceof ReadableStream) init.duplex = 'half'
    const res = await this.app.request(`http://panel.test${path}`, init)
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';')
      const eq = pair!.indexOf('=')
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))
      if (expired || value === '') this.jar.delete(name)
      else this.jar.set(name, value)
    }
    return res
  }
}
