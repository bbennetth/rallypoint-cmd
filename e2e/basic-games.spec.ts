import { expect, test, type Page } from '@playwright/test'

// One game per settings-adapter family, since what differs between them
// is the config file the panel has to read and write:
//   Valheim  — panel-owned launch conf, no admin protocol
//   ARK      — sectioned ini, RCON player admin, world backups
//   7DTD     — XML properties, telnet player admin
//   TF2      — Source cfg, RCON player admin, no world to back up
// Together they cover every capability combination the registry now
// declares outside Palworld and Enshrouded.

test.describe.configure({ mode: 'serial' })

async function open(page: Page, slug: string, name: string): Promise<void> {
  await page.goto('/')
  const addBtn = page.getByRole('button', { name: 'Add server' }).first()
  await expect(addBtn).toBeVisible()
  await expect(
    page
      .getByRole('button', { name: /^Open / })
      .or(page.getByText('No servers yet'))
      .first(),
  ).toBeVisible()
  const existing = page.getByRole('button', { name: `Open ${name}` })
  if ((await existing.count()) > 0) {
    await existing.first().click()
  } else {
    await addBtn.click()
    await page.getByRole('combobox').selectOption(slug)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL(/\/servers\/[a-z0-9]+\/updates$/)
    await page.getByRole('link', { name: 'Dashboard' }).click()
  }
  await expect(page).toHaveURL(/\/servers\/[a-z0-9]+$/)
}

async function install(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Updates' }).click()
  await expect(page).toHaveURL(/\/updates$/)
  // The button reads "Checking…" until the page knows the install state.
  await expect(page.getByRole('button', { name: /Install server|Update server/ })).toBeVisible()
  const fresh = page.getByRole('button', { name: 'Install server' })
  if ((await fresh.count()) > 0) {
    await fresh.click()
    await expect(page.getByText('install: succeeded')).toBeVisible({ timeout: 60_000 })
  }
  // Either path must end with the game installed. Asserting it here means
  // a helper that quietly skips the install fails its own test rather
  // than leaving the one that called it to fail somewhere confusing.
  await expect(page.getByRole('button', { name: 'Update server' })).toBeVisible({ timeout: 60_000 })
}

test('Valheim: launch-conf settings, backups, and no player admin', async ({ page }) => {
  await open(page, 'valheim', 'Valheim')
  await install(page)

  // Vanilla Valheim has no remote admin protocol, so the tab is absent
  // even though the game does answer a Steam query.
  await expect(page.getByRole('link', { name: 'Players' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Mods' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Backups' })).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  const name = page.getByLabel(/Server name/)
  await expect(name).toBeVisible()
  // The panel pins the port the unit was provisioned with.
  await expect(page.getByLabel(/Game port/)).toBeDisabled()

  await name.fill('Rallypoint E2E')
  await page.getByRole('button', { name: /^Save/ }).click()
  await expect(page.getByText(/Unapplied changes/)).toBeVisible()

  // A value the launch conf could not safely carry into a shell is
  // refused rather than escaped — start.sh sources that file as root.
  await name.fill('evil; touch /tmp/rallypoint-e2e-pwned')
  await page.getByRole('button', { name: /^Save/ }).click()
  await expect(page.getByText(/may only contain letters/)).toBeVisible()
})

test('ARK: sectioned-ini settings with panel-managed RCON', async ({ page }) => {
  await open(page, 'ark-survival-evolved', 'ARK: Survival Evolved')
  await install(page)

  await page.getByRole('link', { name: 'Settings' }).click()
  // The panel owns the RCON channel it administers players over.
  await expect(page.getByLabel(/RCON \(panel-managed\)/)).toBeDisabled();
  await expect(page.getByLabel(/RCON port/)).toBeDisabled()
  await expect(page.getByLabel(/Admin password/)).toBeDisabled()

  const session = page.getByLabel(/Session name/)
  await session.fill('Rallypoint Island')
  await page.getByRole('button', { name: /^Save/ }).click()
  await expect(page.getByText(/Unapplied changes/)).toBeVisible()
})

test('ARK: players over RCON and world backups', async ({ page }) => {
  await open(page, 'ark-survival-evolved', 'ARK: Survival Evolved')
  await install(page)
  await page.getByRole('link', { name: 'Dashboard' }).click()
  const start = page.getByRole('button', { name: /^Start/ })
  if (await start.isEnabled()) await start.click()
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('link', { name: 'Players' }).click()
  await expect(page.getByRole('cell', { name: 'ByronTest' })).toBeVisible()
  // RCON reports no player level, so that column is not rendered at all.
  await expect(page.getByRole('columnheader', { name: 'Level' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Kick' }).first()).toBeVisible()

  await page.getByRole('link', { name: 'Backups' }).click()
  await page.getByRole('button', { name: /Create backup/ }).click()
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
    timeout: 40_000,
  })
})

test('7 Days to Die: XML settings the panel corrects in place', async ({ page }) => {
  await open(page, '7-days-to-die', '7 Days to Die')
  await install(page)

  await page.getByRole('link', { name: 'Settings' }).click()
  // The game ships serverconfig.xml with telnet off; the panel turns it
  // back on and fills a password, because that is its admin channel.
  await expect(page.getByLabel(/Telnet \(panel-managed\)/)).toBeDisabled()
  await expect(page.getByLabel(/Telnet port/)).toBeDisabled()
  await expect(page.getByLabel(/Telnet password/)).toBeDisabled()
  await expect(page.getByLabel(/Telnet \(panel-managed\)/)).toHaveValue('true')

  // A key the panel does not manage stays editable.
  const serverName = page.getByLabel(/Server name/)
  await serverName.fill('Rallypoint Navezgane')
  await page.getByRole('button', { name: /^Save/ }).click()
  await expect(page.getByText(/Unapplied changes/)).toBeVisible()
})

test('Team Fortress 2: Source cfg settings and players, but no backups', async ({ page }) => {
  await open(page, 'team-fortress-2', 'Team Fortress 2')
  await install(page)

  // A Source server has no persistent world, so there is nothing to back
  // up — but its config and player admin are both wired.
  await expect(page.getByRole('link', { name: 'Backups' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Players' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByLabel(/RCON password/)).toBeDisabled()
})
