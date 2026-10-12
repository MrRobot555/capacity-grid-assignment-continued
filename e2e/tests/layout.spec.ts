import { expect, test, type Page } from '@playwright/test'
import { FIXTURE, FIXTURE_WEEKS, isCapacityGet, openRange, weekLabels } from './helpers'

// How the grid lays out and reads beyond its numbers: contrast, small screens,
// the sticky header and columns, focus, printing, forced colours, long ranges.

test.use({ locale: 'en-US', timezoneId: 'Europe/Budapest' })

/** WCAG contrast of an element's text against what is behind it. */
async function contrast(page: Page, selector: string, onBar = false): Promise<number> {
  return page.evaluate(
    ([sel, bar]) => {
      const parse = (c: string): number[] => {
        const srgb = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/)
        if (srgb) return [+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255, srgb[4] === undefined ? 1 : +srgb[4]]
        const rgb = c.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/)!
        return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]]
      }
      const over = (top: number[], under: number[]) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]))
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const x = v / 255
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const el = document.querySelector(sel) as HTMLElement
      const page = parse(getComputedStyle(document.body).backgroundColor)
      let behind = page.slice(0, 3)
      if (bar) {
        const first = getComputedStyle(el).backgroundImage.match(/(color\(srgb[^)]*\)|rgba?\([^)]*\))/)![1]
        behind = over(parse(first), behind)
      }
      let shown = over(parse(getComputedStyle(el).color), behind)
      // A faded ancestor fades text and background towards the page.
      let opacity = 1
      for (let n: HTMLElement | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
      shown = over([...shown, opacity], page)
      behind = over([...behind, opacity], page)
      const [a, b] = [lum(shown), lum(behind)]
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    },
    [selector, onBar] as const,
  )
}

// Every red text, in both themes: at least 4.5:1 (WCAG AA), the over-capacity
// numbers measured on their own red bar.
test('red text is readable in both themes, over-capacity numbers on their bar too', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
    await page.locator('.cap-button').first().evaluate((b) => b.insertAdjacentHTML('beforeend', '<span class="unconfirmed"> ?</span>'))
    await page.locator('.cap-button').nth(1).click()
    await page.getByRole('spinbutton').fill('999')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.cap-editor .hint.error')).toBeVisible()
    for (const selector of ['.summary .over-text', '.sub.over-text', '.cap-editor .hint.error', '.cap-button .unconfirmed']) {
      expect(await contrast(page, selector), `${selector} (${scheme})`).toBeGreaterThanOrEqual(4.5)
    }
    expect(await contrast(page, 'td.alloc.over', true), `td.alloc.over on its bar (${scheme})`).toBeGreaterThanOrEqual(4.5)
  }
})

// While the next range loads (or failed), the previous one stays on screen,
// marked as stale; its text stays readable.
test('the grid marked as stale keeps red text readable', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/capacity**', async (route) => {
    if (isCapacityGet(route.request())) await held
    await route.fallback()
  })
  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(page.locator('.scroller')).toHaveClass(/\bstale\b/)
  expect(await contrast(page, 'td.alloc.over', true)).toBeGreaterThanOrEqual(4.5)
  release()
})

// On a phone (390px) or at 400% zoom (320px): the names stay readable, and a
// whole week fits beside the columns that stay at the left, also a week
// labelled with its year in a range longer than a year.
test('a narrow screen keeps names readable and a whole week beside them', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    for (const [from, to] of [[FIXTURE.from, FIXTURE.to], ['2026-09-28', '2027-10-03']]) {
      await page.goto(`/?from=${from}&to=${to}`)
      await expect(page.locator('thead th.week').first()).toBeVisible()
      const room = await page.evaluate(() => {
        const scroller = document.querySelector('.scroller')!.getBoundingClientRect()
        const stuck = [...document.querySelectorAll('thead th')].filter((th) => {
          const cs = getComputedStyle(th)
          return cs.position === 'sticky' && cs.left !== 'auto'
        })
        const edge = Math.max(...stuck.map((th) => th.getBoundingClientRect().right))
        const widest = Math.max(...[...document.querySelectorAll('thead th.week')].map((th) => th.getBoundingClientRect().width))
        return { room: scroller.right - edge, widest, name: document.querySelector('thead th.name')!.getBoundingClientRect().width }
      })
      expect(room.room, `${width}px, ${from}`).toBeGreaterThanOrEqual(room.widest)
      expect(room.name, `${width}px: names readable`).toBeGreaterThanOrEqual(120)
    }
  }
})

// Scrolled down and right, the week headers stay at the top and the name and
// capacity columns at the left, side by side.
test('the header row and the name and capacity columns stay in place while scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  const weeks = ['29 Dec', '5 Jan', '12 Jan', '19 Jan', '26 Jan', '2 Feb', '9 Feb', '16 Feb', '23 Feb', '2 Mar', '9 Mar', '16 Mar']
  await openRange(page, '2025-12-29', '2026-03-22', weeks)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => el.scrollTo(400, 3000))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(2000)
  const box = (await scroller.boundingBox())!
  const header = (await page.locator('thead th.week').last().boundingBox())!
  expect(Math.abs(header.y - box.y)).toBeLessThan(3)
  const name = (await page.locator('tbody th.name').nth(10).boundingBox())!
  const cap = (await page.locator('tbody td.cap').nth(10).boundingBox())!
  expect(Math.abs(name.x - box.x)).toBeLessThan(3)
  expect(Math.abs(cap.x - (name.x + name.width))).toBeLessThan(2)
  // The header corner stays above the week headers scrolling under it.
  for (const cls of ['name', 'cap']) {
    const corner = (await page.locator(`thead th.${cls}`).boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('th')?.className,
      [corner.x + corner.width / 2, corner.y + corner.height / 2],
    )
    expect(hit).toBe(cls)
  }
})

// A capacity button scrolled into view by focus must not sit under the header.
test('a focused capacity button is never hidden under the sticky header', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 3000))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(2000)
  // The header cells are sticky (the thead box itself scrolls away).
  const head = (await page.locator('thead th.week').first().boundingBox())!
  // A row of the overscan, above the visible part, found by its person: the
  // fix's own scroll shifts which rows are rendered.
  const buttons = page.locator('.cap-button')
  let id: string | null = null
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = (await buttons.nth(i).boundingBox())!
    if (b.y + b.height < head.y + head.height) id = await buttons.nth(i).getAttribute('data-person-id')
  }
  expect(id).not.toBeNull()
  const button = page.locator(`.cap-button[data-person-id="${id}"]`)
  await button.focus()
  await expect.poll(async () => (await button.boundingBox())!.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
})

// The editor gives focus back to its capacity button without scrolling: the
// grid stays where the manager scrolled it.
test("closing the editor doesn't scroll the grid back to its row", async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  const id = await page.locator('.cap-button').nth(5).getAttribute('data-person-id')
  const button = page.locator(`.cap-button[data-person-id="${id}"]`)
  await button.click()
  await expect(page.locator('.cap-editor')).toBeVisible()
  // Scroll so the row sits just above the view, still rendered.
  await scroller.evaluate((el, b) => (el.scrollTop = (b as HTMLElement).closest('tr')!.offsetTop + 120), await button.elementHandle())
  const before = await scroller.evaluate((el) => el.scrollTop)
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  await page.waitForTimeout(200)
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before)
})

// Scrolling a focused button's row out of the rendered window removes it:
// focus stays in the grid, not on the page.
test('focus stays in the grid when its row is scrolled away', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.locator('.cap-button').first().focus()
  await page.locator('.scroller').evaluate((el) => (el.scrollTop = 8000))
  await expect(page.locator('.scroller')).toBeFocused()
})

// Printing prints what is on screen (rendering every row of a large roster
// would freeze the tab, and wide ranges are wider than a page), and says so.
test('printing says it prints what is on screen, without rendering the whole roster', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const rows = page.locator('tbody tr:not(.spacer)')
  const shown = await rows.count()
  await expect(page.locator('.print-note')).toBeHidden()
  await page.emulateMedia({ media: 'print' })
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
  await expect(page.locator('.print-note')).toBeVisible()
  await expect(page.locator('.print-note')).toContainText('only the people and weeks in view are included')
  expect(await rows.count()).toBe(shown)
})

// The current week is marked for screen readers, and in forced colours, where
// shadows are dropped.
test('the current week is marked for screen readers and in forced colours', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-07T12:00:00'))
  await page.emulateMedia({ forcedColors: 'active' })
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const current = page.locator('thead th.week.current')
  await expect(current).toHaveText(/^5 Jan/)
  await expect(current).toHaveAttribute('aria-current', 'date')
  await expect(current).toHaveCSS('outline-style', 'solid')
})

// Past a year the same weeks of two years sit in one range ("12 Oct" 2026
// beside "11 Oct" 2027): headers and cell tooltips carry the year.
test('a range longer than a year names the year of each week', async ({ page }) => {
  await page.goto('/?from=2026-10-12&to=2027-10-17')
  await expect(page.locator('thead th.week')).toHaveCount(53)
  const labels = await weekLabels(page)
  expect(labels[0]).toBe('12 Oct 2026')
  expect(labels[52]).toBe('11 Oct 2027')
  await expect(page.locator('tbody td.alloc').first()).toHaveAttribute('title', /week of 12 Oct 2026:/)
})
