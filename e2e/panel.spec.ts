import { expect, test } from '@playwright/test'

// End-to-end against the real built panel in mock mode. Mirrors the
// operator's core loop: log in, open the (seeded) Palworld server,
// install, start, back up.

// Log in and land on the server list, then open the default server.
async function loginAndOpenServer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1234')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible()
  await page.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/servers\/default$/)
}

test('operator can log in and drive the server lifecycle', async ({ page }) => {
  await loginAndOpenServer(page)

  // Dashboard: fresh mock world starts uninstalled.
  await expect(page.getByText('Palworld is not installed')).toBeVisible()

  // Install via the Updates page.
  await page.getByRole('link', { name: 'Install server' }).click()
  await expect(page).toHaveURL(/\/updates$/)
  await page.getByRole('button', { name: /Install server/ }).click()
  // Progress card appears and the op eventually succeeds.
  await expect(page.getByText(/install: (running|succeeded)/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('install: succeeded')).toBeVisible({ timeout: 60_000 })

  // Back to the dashboard, start the server, expect it to go Running.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: /Start/ }).click()
  // `exact` matters: once the unit is up, the systemd detail row also renders
  // "active / running", and a substring match resolves to two elements.
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })
})

test('backups: create then list', async ({ page }) => {
  await loginAndOpenServer(page)

  await page.getByRole('link', { name: 'Backups' }).click()
  await page.getByRole('button', { name: /Create backup/ }).click()
  // A backup row (with a Download action) appears once the op completes.
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
    timeout: 40_000,
  })
})

test('default schedules are seeded', async ({ page }) => {
  await loginAndOpenServer(page)

  await page.getByRole('link', { name: 'Schedules' }).click()
  await expect(page.getByText('restart').first()).toBeVisible()
  await expect(page.getByText('backup').first()).toBeVisible()
})
