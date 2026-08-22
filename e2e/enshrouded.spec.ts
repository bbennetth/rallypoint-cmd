import { expect, test, type Page } from '@playwright/test'

// Enshrouded full-support flow in mock mode: the Windows/Wine-run,
// world-id-free game. Exercises the JSON settings adapter and the
// world-contract backup path; asserts the capability-gated nav hides
// Players/Mods (no admin API, no mod system).

test.describe.configure({ mode: 'serial' })

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1234')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

// Land on the Enshrouded server's dashboard: open the existing one, or add it.
async function ensureEnshroudedOpen(page: Page): Promise<void> {
  await login(page)
  const addBtn = page.getByRole('button', { name: 'Add server' }).first()
  await expect(addBtn).toBeVisible()
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

async function ensureInstalled(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Updates' }).click()
  await expect(page).toHaveURL(/\/updates$/)
  const install = page.getByRole('button', { name: 'Install server' })
  if ((await install.count()) === 0) return
  await install.click()
  await expect(page.getByText('install: succeeded')).toBeVisible({ timeout: 60_000 })
}

test('add Enshrouded, install, and start it', async ({ page }) => {
  await ensureEnshroudedOpen(page)
  await ensureInstalled(page)

  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.getByRole('button', { name: /Start/ }).click()
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })
})

test('capability-gated nav: Settings + Backups present, Players + Mods absent', async ({ page }) => {
  await ensureEnshroudedOpen(page)
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Backups' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Players' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Mods' })).toHaveCount(0)
})

test('JSON settings: edit slotCount, save, pending-restart banner', async ({ page }) => {
  await ensureEnshroudedOpen(page)
  await ensureInstalled(page)

  await page.getByRole('link', { name: 'Settings' }).click()
  const maxPlayers = page.getByLabel(/Max players/)
  await expect(maxPlayers).toBeVisible()
  await maxPlayers.fill('8')
  await page.getByRole('button', { name: /Save/ }).click()
  await expect(page.getByText(/Unapplied changes/)).toBeVisible()
  // Managed key rendered read-only.
  await expect(page.getByLabel(/Query port/)).toBeDisabled()
})

test('backups: create shows a world-less row', async ({ page }) => {
  await ensureEnshroudedOpen(page)
  await ensureInstalled(page)

  await page.getByRole('link', { name: 'Backups' }).click()
  await page.getByRole('button', { name: /Create backup/ }).click()
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
    timeout: 40_000,
  })
  // World column shows the em-dash placeholder (no world id).
  await expect(page.getByRole('cell', { name: '—' }).first()).toBeVisible()
})
