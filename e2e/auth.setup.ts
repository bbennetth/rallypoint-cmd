import { expect, test as setup } from '@playwright/test'
import { STATE_PATH } from './auth-state.js'

// One sign-in for the whole suite. The panel rate-limits login attempts
// (10 per IP+user per 10 minutes — deliberately tight, since a
// single-admin panel's login is the whole security boundary), and a
// suite that logs in per test trips that limit partway through and fails
// tests for reasons that have nothing to do with what they assert.

setup('authenticate once for the suite', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1234')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Add server' }).first()).toBeVisible()
  await page.context().storageState({ path: STATE_PATH })
})
