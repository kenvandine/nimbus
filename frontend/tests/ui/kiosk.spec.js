import { test, expect } from '@playwright/test'

test.describe('Nimbus UI Flow Tests', () => {
  
  test('should display OOBE onboarding screen when not configured', async ({ page }) => {
    // Intercept auth/status to say the app is not configured (OOBE mode)
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { configured: false, authenticated: false, username: null },
      })
    })

    // Mock stats
    await page.route('**/api/system/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          cpu_pct: 10,
          mem_pct: 20,
          disk_pct: 30,
          app_count: 0,
          oobe_complete: false,
          control_mode: 'local',
        },
      })
    })

    // Mock list apps
    await page.route('**/api/apps', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [],
      })
    })

    // Mock active installs
    await page.route('**/api/apps/installing/active', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [],
      })
    })

    await page.goto('/')

    // Verify OOBE/Setup page is displayed
    // It should have a title like "Let's get you online" or setup headers.
    await expect(page.locator('body')).toContainText("Let's get you online")
  })

  test('should display Login screen when configured but not authenticated', async ({ page }) => {
    // Intercept auth/status to say the app is configured but not logged in
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { configured: true, authenticated: false, username: null },
      })
    })

    await page.goto('/')

    // Verify Login page is displayed
    await expect(page.locator('body')).toContainText('Welcome back')
  })

  test('should display Dashboard when authenticated', async ({ page }) => {
    // Intercept auth/status to say the app is configured and authenticated
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { configured: true, authenticated: true, username: 'admin' },
      })
    })

    // Mock stats
    await page.route('**/api/system/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          cpu_pct: 15.5,
          mem_pct: 42.0,
          disk_pct: 58.2,
          app_count: 3,
          oobe_complete: true,
          control_mode: 'local',
          version: '0.1.0',
        },
      })
    })

    // Mock list apps
    await page.route('**/api/apps', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [],
      })
    })

    // Mock active installs
    await page.route('**/api/apps/installing/active', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [],
      })
    })

    await page.goto('/')

    // Verify main dashboard/dock or system stats info is displayed
    await expect(page.locator('body')).toContainText('Sign out')
    await expect(page.locator('body')).toContainText('No apps running yet')
  })
})
