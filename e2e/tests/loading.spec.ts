import { expect, test } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_WEEKS,
  capacityFrom,
  expectWeeks,
  isCapacityGet,
  openRange,
  personRows,
  rangeURL,
  routeApi,
  settle,
  sleep,
} from './helpers'

const NEXT_WEEKS = ['5 Jan', '12 Jan', '19 Jan']

test('out-of-order responses: the last navigation wins and stays', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  const HOLD_MS = 1500
  let heldDone: Promise<void> | null = null
  await routeApi(page, async (route, req) => {
    if (!isCapacityGet(req) || capacityFrom(req) !== '2026-01-05') return false
    heldDone = (async () => {
      const response = await route.fetch()
      await sleep(HOLD_MS)
      await settle(() => route.fulfill({ response }))
    })()
    await heldDone
    return true
  })

  const next = page.getByRole('button', { name: 'Next week' })
  await next.click()
  await next.click()

  await expectWeeks(page, ['12 Jan', '19 Jan', '26 Jan'])
  await expect(page).toHaveURL(/[?&]from=2026-01-12&to=2026-02-01(&|$)/)

  // Wait until the held response has been delivered (or dropped), and then some.
  await expect.poll(() => heldDone !== null).toBe(true)
  await heldDone
  await sleep(500)

  await expectWeeks(page, ['12 Jan', '19 Jan', '26 Jan'])
  await expect(page).toHaveURL(/[?&]from=2026-01-12&to=2026-02-01(&|$)/)
  await expect(page.locator('.summary')).toContainText('12 Jan 2026 – 1 Feb 2026')
  await expect(page.locator('.scroller')).not.toHaveClass(/\bstale\b/)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('slow load: "Still loading" while the previous grid stays, dimmed', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  await routeApi(page, async (route, req) => {
    if (!isCapacityGet(req) || capacityFrom(req) !== '2026-01-05') return false
    const response = await route.fetch()
    await sleep(2500)
    await settle(() => route.fulfill({ response }))
    return true
  })

  await page.getByRole('button', { name: 'Next week' }).click()

  const status = page.getByRole('status')
  await expect(status).toHaveText('Loading…')
  await expect(status).toHaveText(/Still loading/, { timeout: 2400 })
  // The previous range is still rendered, dimmed.
  await expect(page.locator('.scroller')).toHaveClass(/\bstale\b/)
  await expectWeeks(page, FIXTURE_WEEKS)
  expect(await personRows(page).count()).toBeGreaterThan(0)

  await expectWeeks(page, NEXT_WEEKS)
  await expect(page.locator('.scroller')).not.toHaveClass(/\bstale\b/)
  await expect(status).toHaveText('')
})

test('load failure (502 HTML) keeps the previous grid; Retry recovers', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  let failing = true
  await routeApi(page, async (route, req) => {
    if (!failing || !isCapacityGet(req) || capacityFrom(req) !== '2026-01-05') return false
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' })
    return true
  })

  await page.getByRole('button', { name: 'Next week' }).click()

  const banner = page.locator('.banner[role=alert]')
  await expect(banner).toContainText("Couldn't load 5 Jan 2026 – 25 Jan 2026")
  await expect(banner).toContainText("The server couldn't handle the request (502).")
  await expect(banner).toContainText('The grid below still shows the previous range.')
  await expectWeeks(page, FIXTURE_WEEKS)
  expect(await personRows(page).count()).toBeGreaterThan(0)

  failing = false
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await banner.getByRole('button', { name: 'Retry' }).click()

  await expect(banner).toHaveCount(0)
  await expectWeeks(page, NEXT_WEEKS)
  await expect(page.locator('.scroller')).not.toHaveClass(/\bstale\b/)
})

test('network abort on the very first load: banner, no table; Retry recovers', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'))

  await page.goto(rangeURL(FIXTURE.from, FIXTURE.to))

  const banner = page.locator('.banner[role=alert]')
  await expect(banner).toContainText("Couldn't reach the server")
  await expect(banner).not.toContainText('previous range')
  await expect(page.locator('table')).toHaveCount(0)

  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await banner.getByRole('button', { name: 'Retry' }).click()

  await expect(banner).toHaveCount(0)
  await expectWeeks(page, FIXTURE_WEEKS)
})

test('200 with a non-JSON body shows "could not read"', async ({ page }) => {
  await routeApi(page, async (route, req) => {
    if (!isCapacityGet(req)) return false
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"weeks": [' })
    return true
  })

  await page.goto(rangeURL(FIXTURE.from, FIXTURE.to))

  const banner = page.locator('.banner[role=alert]')
  await expect(banner).toContainText('The server sent a response we could not read.')
  await expect(page.locator('table')).toHaveCount(0)
})
