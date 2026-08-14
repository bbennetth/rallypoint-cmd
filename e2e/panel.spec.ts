import { expect, test, type Page } from '@playwright/test'

// End-to-end against the real built panel in mock mode. A fresh install
// has NO servers — the operator adds one from the panel, then installs,
// starts, backs up. The panel process (and its DB) is shared across these
// tests, so they run serially and share one Palworld server.

test.describe.configure({ mode: 'serial' })

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1234')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

// Land on a Palworld server's dashboard: open the existing one, or add it.
async function ensurePalworldOpen(page: Page): Promise<void> {
  await login(page)
  // The "Add server" button renders once the list has loaded (spinner
  // before that), so it's a reliable "list ready" signal.
  const addBtn = page.getByRole('button', { name: 'Add server' }).first()
  await expect(addBtn).toBeVisible()
  const open = page.getByRole('button', { name: 'Open' })
  if ((await open.count()) > 0) {
    await open.first().click()
  } else {
    await addBtn.click()
    await page.getByRole('combobox').selectOption('palworld')
    await page.getByRole('button', { name: 'Create' }).click()
    // Create lands on the new server's Updates page; go to its dashboard.
    await expect(page).toHaveURL(/\/servers\/[a-z0-9]+\/updates$/)
    await page.getByRole('link', { name: 'Dashboard' }).click()
  }
  await expect(page).toHaveURL(/\/servers\/[a-z0-9]+$/)
}

// Install the game if it isn't already, from the Updates page. When the
// game is already installed the primary button reads "Update server", so
// we skip (no need to churn a running server).
async function ensureInstalled(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Updates' }).click()
  await expect(page).toHaveURL(/\/updates$/)
  const install = page.getByRole('button', { name: 'Install server' })
  if ((await install.count()) === 0) return
  await install.click()
  await expect(page.getByText('install: succeeded')).toBeVisible({ timeout: 60_000 })
}

test('add a server from an empty panel, install and start it', async ({ page }) => {
  await ensurePalworldOpen(page)
  await expect(page.getByText('Palworld is not installed')).toBeVisible()

  await ensureInstalled(page)

  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: /Start/ }).click()
  // `exact`: once up, the systemd detail row also renders "active / running".
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })
})

test('new server seeded default schedules', async ({ page }) => {
  await ensurePalworldOpen(page)
  await page.getByRole('link', { name: 'Schedules' }).click()
  await expect(page.getByText('restart').first()).toBeVisible()
  await expect(page.getByText('backup').first()).toBeVisible()
})

test('backups: create then list', async ({ page }) => {
  await ensurePalworldOpen(page)
  await ensureInstalled(page)

  await page.getByRole('link', { name: 'Backups' }).click()
  await page.getByRole('button', { name: /Create backup/ }).click()
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
    timeout: 40_000,
  })
})
