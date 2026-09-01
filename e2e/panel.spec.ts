import { expect, test, type Page } from '@playwright/test'

// End-to-end against the real built panel in mock mode. A fresh install
// has NO servers — the operator adds one from the panel, then installs,
// starts, backs up. The panel process (and its DB) is shared across these
// tests, so they run serially and share one Palworld server.

test.describe.configure({ mode: 'serial' })

// The suite signs in once (auth.setup.ts) and every test starts from that
// saved session, so this only has to land on the server list.
async function login(page: Page): Promise<void> {
  await page.goto('/')
}

// Land on a Palworld server's dashboard: open the existing one, or add it.
async function ensurePalworldOpen(page: Page): Promise<void> {
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
  const open = page.getByRole('button', { name: 'Open Palworld' })
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
  // The primary button reads "Checking…" until the page knows whether the
  // server is installed — reading it before then races the fetch and can
  // both miss the install and fire the wrong steamcmd op.
  await expect(page.getByRole('button', { name: /Install server|Update server/ })).toBeVisible()
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

// Runs after the backup test (serial), so a Palworld install and at least
// one backup archive exist on disk. Only Palworld data is touched — the
// enshrouded spec shares the panel process.
test('management: panel updater and storage, delete a backup directory', async ({ page }) => {
  await login(page)

  // Management is panel-level: reachable straight from the server list.
  await page.getByRole('link', { name: 'Management' }).click()
  await expect(page).toHaveURL(/\/management$/)

  // The Rallypoint updater card moved here (the fake always has v9.9.9 pending).
  await expect(page.getByText('update available')).toBeVisible()

  // Storage: the Palworld install dir is listed with its server attached.
  const gamesCard = page.locator('section.pl-card').filter({ hasText: 'Game files' })
  await expect(gamesCard.getByRole('cell', { name: /palworld/ }).first()).toBeVisible()

  // Delete the Palworld server's backup directory (the enshrouded spec
  // shares the panel — don't touch its rows) via the typed confirmation.
  const backupsCard = page.locator('section.pl-card').filter({ hasText: 'Backup storage' })
  const row = backupsCard.getByRole('row').filter({ hasText: 'Palworld' }).first()
  const dirName = (await row.locator('td').first().innerText()).trim()
  await row.getByRole('button', { name: 'Delete' }).click()

  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', { name: 'Delete permanently' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(dirName)
  await confirm.click()

  await expect(page.getByText('Backup directory deleted.')).toBeVisible({ timeout: 30_000 })
  await expect(backupsCard.getByText(dirName)).toHaveCount(0)

  // The server's Backups tab reflects the purge — no phantom rows.
  await page.getByRole('link', { name: 'Servers' }).click()
  await page.getByRole('button', { name: 'Open Palworld' }).first().click()
  await page.getByRole('link', { name: 'Backups' }).click()
  await expect(page.getByText('No backups yet.')).toBeVisible()
})
