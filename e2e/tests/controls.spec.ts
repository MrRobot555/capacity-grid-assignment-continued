import { expect, test } from '@playwright/test'
import { FIXTURE, FIXTURE_WEEKS, expectWeeks, isCapacityGet, openRange, weekLabels } from './helpers'

// Every control the brief asks for — backward, forward, and choosing a range —
// plus the range in the URL. Each test checks the weeks shown and the URL.

test.use({ locale: 'en-US', timezoneId: 'Europe/Budapest' })

test('Previous week moves back one week', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.getByRole('button', { name: 'Previous week' }).click()
  await expectWeeks(page, ['22 Dec', '29 Dec', '5 Jan'])
  await expect(page).toHaveURL(/from=2025-12-22&to=2026-01-11/)
})

test('This week jumps to the current week and keeps the number of weeks', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-09T12:00:00'))
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.getByRole('button', { name: 'This week' }).click()
  await expectWeeks(page, ['5 Oct', '12 Oct', '19 Oct'])
  await expect(page).toHaveURL(/from=2026-10-05&to=2026-10-25/)
})

test('Show changes the number of weeks from the same start', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.getByLabel('Show').selectOption('4')
  await expectWeeks(page, ['29 Dec', '5 Jan', '12 Jan', '19 Jan'])
  await expect(page).toHaveURL(/from=2025-12-29&to=2026-01-25/)
})

// Typed, not filled: the field must not be rewritten under the cursor while
// someone types (it used to land on 2024-12-02 for 03/02/2026).
test('typing a From date lands on the week of that date', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const from = page.getByLabel('From', { exact: true })
  await from.focus()
  await page.keyboard.type('03022026', { delay: 80 })
  await page.keyboard.press('Tab')
  // 2 Mar 2026 is a Monday, and From past To keeps the 3 weeks shown.
  await expectWeeks(page, ['2 Mar', '9 Mar', '16 Mar'])
  await expect(page).toHaveURL(/from=2026-03-02&to=2026-03-22/)
  await expect(from).toHaveValue('2026-03-02')
})

test('typing a To date ends the range with the week containing it', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const requested: string[] = []
  page.on('request', (req) => {
    if (isCapacityGet(req)) requested.push(new URL(req.url()).search)
  })
  const to = page.getByLabel('To', { exact: true })
  await to.focus()
  await page.keyboard.type('01282026', { delay: 80 })
  await page.keyboard.press('Enter')
  // Wednesday 28 Jan → the week of 26 Jan is the last one.
  await expect.poll(() => weekLabels(page)).toEqual(['29 Dec', '5 Jan', '12 Jan', '19 Jan', '26 Jan'])
  await expect(page).toHaveURL(/from=2025-12-29&to=2026-02-01/)
  // No request for a half-typed year (0002, 0020, 0202).
  expect(requested.filter((q) => /=0\d\d\d-/.test(q))).toEqual([])
})

test('a URL range longer than the API serves is shortened, not an error', async ({ page }) => {
  await page.goto('/?from=2025-01-06&to=2030-01-06')
  await expect(page).toHaveURL(/from=2025-01-06&to=2027-01-17/)
  await expect(page.locator('thead th.week')).toHaveCount(106)
  await expect(page.locator('.banner')).toHaveCount(0)
})

test('an unusable URL range falls back to the default (this week + 7)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-09T12:00:00'))
  await page.goto('/?from=nope&to=2026-01-18')
  await expect(page).toHaveURL(/from=2026-10-05&to=2026-11-29/)
  await expect(page.locator('thead th.week')).toHaveCount(8)
})
