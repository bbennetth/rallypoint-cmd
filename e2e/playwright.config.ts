import { defineConfig, devices } from '@playwright/test'
import { STATE_PATH } from './auth-state.js'

// Drives the real built panel in mock mode (fake game/steamcmd/rest/backup
// services over a temp sandbox) — no LXC or real Palworld needed. The
// webServer builds the SPA and boots the Hono server serving it.
//
// NOTE: run locally (`npm run e2e`), not in a restricted sandbox — the
// server binds a TCP port.
const PORT = 18099
const ROOT = new URL('..', import.meta.url).pathname

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  // One worker, not just one test at a time: every spec drives the same
  // panel process, database and games dir, so running two spec files
  // concurrently has them fight over server creation and the per-server
  // world lock. `fullyParallel: false` alone still gives each file its
  // own worker.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STATE_PATH },
    },
  ],
  webServer: {
    command: `npm run build --workspace=@rallypoint-cmd/web && npx tsx apps/server/src/server.ts`,
    cwd: ROOT,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PANEL_MODE: 'mock',
      PANEL_PORT: String(PORT),
      PANEL_ADMIN_PASSWORD: 'e2e-password-1234',
      PANEL_PASSWORD_PEPPER: 'e2e-pepper-0123456789abcdef0123',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'production',
      WEB_DIST_DIR: `${ROOT}/apps/web/dist`,
    },
  },
})
