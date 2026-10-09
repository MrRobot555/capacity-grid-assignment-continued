import { expect, test, type Page } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_WEEKS,
  capButton,
  expectCell,
  expectWeeks,
  openRange,
  overCounts,
  rangeURL,
  summaryCounts,
} from './helpers'

// Ground truth from db/seed.sql for 29 Dec 2025 – 18 Jan 2026.
const FIXTURE_PEOPLE: { name: string; cap: string; cells: [string, string][] }[] = [
  { name: 'Ana Ferreira', cap: '40h', cells: [['40', 'full'], ['–', 'none'], ['30', 'under']] },
  { name: 'Bo Lindqvist', cap: '40h', cells: [['–', 'none'], ['32', 'under'], ['8', 'under']] },
  { name: 'Cem Aydin', cap: '20h', cells: [['–', 'none'], ['4', 'under'], ['12', 'under']] },
  { name: 'Dee Okafor', cap: '40h', cells: [['–', 'none'], ['45 +5', 'over'], ['40', 'full']] },
  { name: 'Eli Nakamura', cap: '0h', cells: [['–', 'none'], ['20 +20', 'over'], ['–', 'none']] },
]

async function expectFixtureHeaders(page: Page) {
  await page.goto(rangeURL(FIXTURE.from, FIXTURE.to))
  await expectWeeks(page, FIXTURE_WEEKS)
  await expect(page).toHaveURL(/from=2025-12-29&to=2026-01-18/)
}

test('fixture range renders the seeded numbers, statuses and header over-counts', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  await expect(page.locator('.summary')).toContainText('29 Dec 2025 – 18 Jan 2026 · 3 weeks')
  expect(await summaryCounts(page)).toEqual({ over: 41, total: 500 })
  await expect.poll(() => overCounts(page)).toEqual(['39 over', '15 over', 'none over'])

  for (const person of FIXTURE_PEOPLE) {
    await expect(capButton(page, person.name)).toHaveText(person.cap)
    for (const [i, [text, status]] of person.cells.entries()) {
      await expectCell(page, person.name, i, text, status)
    }
  }
})

for (const timezoneId of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
  test.describe(`in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test(`fixture week headers are the same Mondays (${timezoneId})`, async ({ page }) => {
      await expectFixtureHeaders(page)
      await expect(page.locator('.summary')).toContainText('29 Dec 2025 – 18 Jan 2026 · 3 weeks')
    })
  })
}

for (const timezoneId of ['Europe/Budapest', 'America/New_York']) {
  test.describe(`DST in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test(`weeks across the October DST change, then Next week (${timezoneId})`, async ({ page }) => {
      await openRange(page, '2026-10-19', '2026-11-08', ['19 Oct', '26 Oct', '2 Nov'])

      await page.getByRole('button', { name: 'Next week' }).click()

      await expectWeeks(page, ['26 Oct', '2 Nov', '9 Nov'])
      await expect(page).toHaveURL(/[?&]from=2026-10-26&to=2026-11-15(&|$)/)
      await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-10-26')
      await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-11-15')
    })
  })
}
