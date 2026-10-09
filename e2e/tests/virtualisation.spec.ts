import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_WEEKS, openRange, personRows, rowFor } from './helpers'

type ApiPerson = { id: number; name: string }

async function namesInGridOrder(request: import('@playwright/test').APIRequestContext): Promise<string[]> {
  const res = await request.get(`/api/capacity?from=${FIXTURE.from}&to=${FIXTURE.to}`)
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { people: ApiPerson[] }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
  return [...body.people].sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id).map((p) => p.name)
}

async function scrollTo(page: Page, top: number) {
  await page.locator('.scroller').evaluate((el, t) => {
    el.scrollTop = t
    el.dispatchEvent(new Event('scroll'))
  }, top)
  // Let React re-render the window for the new position.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Geometry of the scroller's visible box and of every rendered person row. */
async function geometry(page: Page) {
  return page.locator('.scroller').evaluate((el) => {
    const box = el.getBoundingClientRect()
    const top = box.top + el.clientTop
    const head = el.querySelector('thead th')!.getBoundingClientRect()
    const rows = [...el.querySelectorAll('tbody tr:not(.spacer)')].map((tr) => {
      const r = tr.getBoundingClientRect()
      return { name: tr.querySelector('th.name')!.textContent!.trim(), top: r.top, bottom: r.bottom, height: r.height }
    })
    return {
      scrollTop: el.scrollTop,
      maxScrollTop: el.scrollHeight - el.clientHeight,
      visibleTop: top,
      visibleBottom: top + el.clientHeight,
      headBottom: head.bottom,
      rows,
    }
  })
}

// At the default font the rows are exactly the 44px the code guesses, so the
// guess alone would pass. 17px gives fractional row heights, which only a real
// measurement handles.
for (const fontSize of ['default', '17px']) {
test(`virtualised rows (${fontSize} font): the right person at the bottom and mid-scroll, all rows the same height`, async ({
  page,
  request,
}) => {
  if (fontSize !== 'default') {
    await page.addInitScript((size) => {
      document.addEventListener('DOMContentLoaded', () => (document.documentElement.style.fontSize = size))
    }, fontSize)
  }
  const names = await namesInGridOrder(request)
  expect(names.length).toBe(500)
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await expect(personRows(page).first()).toBeVisible()
  await expect(page.locator('.scroller')).not.toHaveClass(/\bstale\b/)

  // --- Bottom: the last person is rendered and fully inside the visible box.
  await scrollTo(page, 1e9)
  const lastName = names[names.length - 1]
  await expect(rowFor(page, lastName)).toHaveCount(1)
  const bottom = await geometry(page)
  expect(bottom.scrollTop).toBeGreaterThan(0)
  const lastRow = bottom.rows.find((r) => r.name === lastName)!
  expect(lastRow, `${lastName} row geometry`).toBeTruthy()
  expect(lastRow.top).toBeGreaterThanOrEqual(bottom.headBottom - 0.5)
  expect(lastRow.bottom).toBeLessThanOrEqual(bottom.visibleBottom + 0.5)
  expect(bottom.rows[bottom.rows.length - 1].name).toBe(lastName)

  // --- Middle: the row right under the sticky header is the one its index says.
  const rowHeight = (await geometry(page)).rows[0].height
  expect(rowHeight).toBeGreaterThan(0)
  const k = 250
  // Half a row in, so rounding can't decide the answer; drift of a pixel a row can.
  const target = Math.round((k + 0.5) * rowHeight)
  await scrollTo(page, target)
  const mid = await geometry(page)
  expect(mid.scrollTop).toBeCloseTo(target, 0)
  const expectedIndex = Math.floor(mid.scrollTop / rowHeight)
  const probeY = mid.headBottom + 1
  const atTop = mid.rows.find((r) => r.top <= probeY && r.bottom > probeY)
  expect(atTop?.name, `row under the header at scrollTop ${mid.scrollTop} (rowHeight ${rowHeight})`).toBe(
    names[expectedIndex],
  )

  // --- Every rendered row has the same height.
  const heights = [...new Set(mid.rows.map((r) => Math.round(r.height * 100) / 100))]
  expect(heights, 'distinct heights of rendered rows').toEqual([Math.round(rowHeight * 100) / 100])
  // And the rendered rows are consecutive people in collation order.
  const firstIdx = names.indexOf(mid.rows[0].name)
  expect(mid.rows.map((r) => r.name)).toEqual(names.slice(firstIdx, firstIdx + mid.rows.length))
})
}
