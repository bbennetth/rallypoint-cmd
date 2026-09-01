import { expect, test, type Page } from '@playwright/test'

// The Monitoring tab in mock mode. The fake sampler backfills a history
// window and logs an overload line on every spike, so the page has real
// shape to render without waiting on a real game.

test.describe.configure({ mode: 'serial' })

// The suite signs in once (auth.setup.ts) and every test starts from that
// saved session, so this only has to land on the server list.
async function login(page: Page): Promise<void> {
  await page.goto('/')
}

async function ensureEnshroudedOpen(page: Page): Promise<void> {
  await login(page)
  const addBtn = page.getByRole('button', { name: 'Add server' }).first()
  await expect(addBtn).toBeVisible()
  // The header button renders before the server list resolves, so it is
  // not a "list ready" signal on its own: checking for an existing server
  // too early adds a duplicate instead of opening the one already there.
  await expect(
    page
      .getByRole('button', { name: /^Open / })
      .or(page.getByText('No servers yet'))
      .first(),
  ).toBeVisible()
  const open = page.getByRole('button', { name: 'Open Enshrouded' })
  if ((await open.count()) > 0) {
    await open.first().click()
  } else {
    await addBtn.click()
    await page.getByRole('combobox').selectOption('enshrouded')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL(/\/servers\/[a-z0-9]+\/updates$/)
    await page.getByRole('link', { name: 'Dashboard' }).click()
  }
  await expect(page).toHaveURL(/\/servers\/[a-z0-9]+$/)
}

// Leaves the server running and sitting on the Monitoring page.
//
// The mock world persists across tests in a file, so by the second test
// the game is already installed and running. Installed-ness is therefore
// read off the Dashboard rather than by visiting Updates: that page's
// install button is present but disabled while the unit is up, so a
// blind click there hangs until the test times out.
async function ensureRunningOnMonitoring(page: Page): Promise<void> {
  await ensureEnshroudedOpen(page)
  const start = page.getByRole('button', { name: /Start/ })
  await expect(start).toBeVisible({ timeout: 20_000 })

  if ((await page.getByText('Enshrouded is not installed').count()) > 0) {
    await page.getByRole('link', { name: 'Updates' }).click()
    await expect(page).toHaveURL(/\/updates$/)
    await page.getByRole('button', { name: 'Install server' }).click()
    await expect(page.getByText('install: succeeded')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('link', { name: 'Dashboard' }).click()
    await expect(start).toBeVisible()
  }

  if (await start.isEnabled()) await start.click()
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: 'Monitoring' }).click()
  await expect(page).toHaveURL(/\/monitoring$/)
}

test('Monitoring tab renders live CPU, memory and latency readings', async ({ page }) => {
  await ensureRunningOnMonitoring(page)

  // Each stat tile shows a real reading, not the em-dash placeholder.
  const cpu = page.locator('.cmd-stat', { hasText: 'CPU' }).first()
  await expect(cpu.locator('.cmd-stat-value')).toHaveText(/\d+(\.\d+)?%/, { timeout: 20_000 })

  const memory = page.locator('.cmd-stat', { hasText: 'Memory' }).first()
  await expect(memory.locator('.cmd-stat-value')).toHaveText(/\d+(\.\d+)?\s(B|KiB|MiB|GiB|TiB)/)

  const latency = page.locator('.cmd-stat', { hasText: 'Latency' }).first()
  await expect(latency.locator('.cmd-stat-value')).toHaveText(/\d+\sms/)
})

test('history charts draw from the sampled window', async ({ page }) => {
  await ensureRunningOnMonitoring(page)

  // Backfill means the sparklines have a line, not the "not enough
  // data" placeholder, on the very first render.
  const sparks = page.locator('svg.cmd-spark')
  await expect(sparks.first()).toBeVisible({ timeout: 20_000 })
  expect(await sparks.count()).toBeGreaterThanOrEqual(3)
  await expect(sparks.first().locator('polyline').first()).toBeAttached()
})

test('overload lines from the game reach the recent-errors pane', async ({ page }) => {
  await ensureRunningOnMonitoring(page)

  // The fake spikes on a fixed cadence and logs an overload line with
  // each one, so this is deterministic rather than a race.
  await expect(page.getByText(/Server overloaded/).first()).toBeVisible({ timeout: 30_000 })
  const errorCount = page.locator('.cmd-stat', { hasText: 'Errors' }).first()
  await expect(errorCount.locator('.cmd-stat-value')).toHaveText(/[1-9]\d*/)
})

test('stopping the server shows the paused-sampling notice', async ({ page }) => {
  await ensureRunningOnMonitoring(page)

  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: /Stop/ }).click()
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('link', { name: 'Monitoring' }).click()
  await expect(page.getByText(/sampling resumes when it starts/)).toBeVisible({ timeout: 20_000 })
})
