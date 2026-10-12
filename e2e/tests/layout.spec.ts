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
    await page.getByRole('textbox', { name: /Weekly hours for/ }).fill('999')
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
  await expect(page.locator('.scroller')).toHaveCSS('border-top-style', 'dashed')
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
      await expect(page.locator('thead th.week').first()).toBeVisible({ timeout: 15_000 })
      const room = await page.evaluate(() => {
        const scroller = document.querySelector('.scroller')!.getBoundingClientRect()
        // The cells that stay at the left, in the header and in the rows.
        const cells = [...document.querySelectorAll('thead th'), ...document.querySelectorAll('tbody tr:not(.spacer) > *')]
        const stuck = cells.filter((cell) => {
          const cs = getComputedStyle(cell)
          return cs.position === 'sticky' && cs.left !== 'auto'
        })
        const edge = Math.max(...stuck.map((th) => th.getBoundingClientRect().right))
        const widest = Math.max(...[...document.querySelectorAll('thead th.week')].map((th) => th.getBoundingClientRect().width))
        return { room: scroller.right - edge, widest, name: document.querySelector('thead th.name')!.getBoundingClientRect().width }
      })
      expect(room.room, `${width}px, ${from}`).toBeGreaterThanOrEqual(room.widest)
      expect(room.name, `${width}px: names readable`).toBeGreaterThanOrEqual(120)
      // Scrolled right, the name header stays on top of what scrolls under it.
      await page.locator('.scroller').evaluate((el) => (el.scrollLeft = 200))
      const name = (await page.locator('thead th.name').boundingBox())!
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('th')?.className,
        [name.x + name.width / 2, name.y + name.height / 2],
      )
      expect(hit, `${width}px, ${from}: the name header`).toBe('name')
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

/** The capacity buttons wholly in view: below the sticky header, above the scroller's bottom. */
async function buttonsInView(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.scroller')!
    const top = document.querySelector('thead th.week')!.getBoundingClientRect().bottom
    const bottom = scroller.getBoundingClientRect().bottom
    return [...scroller.querySelectorAll<HTMLElement>('button[data-person-id]')]
      .filter((b) => b.getBoundingClientRect().top >= top - 1 && b.getBoundingClientRect().bottom <= bottom + 1)
      .map((b) => b.dataset.personId!)
  })
}

// Shift+Tab from the first row in view moves to the row above, which the
// browser scrolls in ignoring the sticky header: it must not end up under it.
test('a capacity button reached with Shift+Tab is never hidden under the sticky header', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 3000))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(3000)
  const first = (await buttonsInView(page))[0]
  await page.locator(`.cap-button[data-person-id="${first}"]`).focus()
  await page.keyboard.press('Shift+Tab')
  const focused = page.locator('.cap-button:focus')
  await expect(focused).not.toHaveAttribute('data-person-id', first)
  const head = (await page.locator('thead th.week').first().boundingBox())!
  await expect.poll(async () => (await focused.boundingBox())!.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
})

// Tab moves from row to row: through every row in turn, not back into view.
test('Tab moves through the rows one after another', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const first = (await buttonsInView(page))[0]
  await page.locator(`.cap-button[data-person-id="${first}"]`).focus()
  const visited = [first]
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    visited.push((await page.locator('.cap-button:focus').getAttribute('data-person-id'))!)
  }
  expect(new Set(visited).size).toBe(visited.length)
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

// Tabbing into a scrolled grid starts at a row in view, not at a pre-rendered
// row above it (which would scroll the grid back).
test('tabbing into a scrolled grid starts at a row in view', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 4400))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(4400)
  await scroller.focus()
  await page.keyboard.press('Tab')
  const focused = page.locator('.cap-button:focus')
  await expect(focused).toHaveCount(1)
  await page.waitForTimeout(200)
  const head = (await page.locator('thead th.week').first().boundingBox())!
  const box = (await scroller.boundingBox())!
  const b = (await focused.boundingBox())!
  expect(b.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
  expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height + 1)
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - 4400)).toBeLessThan(50)
})

// Shift+Tab into the grid comes from the browser's own UI (nothing on the page
// comes after the grid): it starts at the last row in view, without a jump.
test('Shift+Tab into a scrolled grid starts at the last row in view', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 4400))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(4400)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Shift+Tab')
  const inView = await buttonsInView(page)
  await expect(page.locator('.cap-button:focus')).toHaveAttribute('data-person-id', inView[inView.length - 1])
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - 4400)).toBeLessThan(50)
})

// With the editor open on the first row in view, its button is disabled:
// Tab into the grid starts at the next row in view instead.
test('tabbing into the grid skips the open editor\'s own button', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 2000))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(2000)
  const [first, second] = await buttonsInView(page)
  await page.locator(`.cap-button[data-person-id="${first}"]`).click()
  await expect(page.locator('.cap-editor')).toBeVisible()
  await scroller.focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('.cap-button:focus')).toHaveAttribute('data-person-id', second)
})

// What makes over-allocation obvious at a glance, and the other marks drawn
// only by the stylesheet: red over-capacity cells, counts and rows; the
// current week's underline; the edited row's highlight; sticky cells that
// hide what scrolls under them.
test('the grid draws its marks: red over capacity, this week, the edited row, opaque sticky cells', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-07T12:00:00'))
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const styles = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!)
    return {
      cell: cs('td.alloc.over').color,
      bar: cs('td.alloc.over').backgroundImage,
      header: cs('.sub.over-text').color,
      summary: cs('.summary .over-text').color,
      row: cs('tr.is-over .name').boxShadow,
      current: cs('thead th.week.current').boxShadow,
      other: cs('thead th.week:not(.current)').boxShadow,
      stickyName: cs('tbody th.name').backgroundColor,
      stickyHead: cs('thead th.week').backgroundColor,
      fullBar: cs('td.alloc.full').backgroundImage,
    }
  })
  // Each bar is drawn as long as its share of the capacity.
  const bars = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('tbody td.alloc')].slice(0, 30).map((td) => ({
      fill: Number(td.style.getPropertyValue('--fill')),
      drawn: getComputedStyle(td).backgroundImage.match(/\) (?:calc\()?([\d.]+)%\)?, rgba/)?.[1],
    })),
  )
  expect(bars.some((b) => b.fill > 0 && b.fill < 1)).toBe(true)
  for (const b of bars) expect(Number(b.drawn), JSON.stringify(b)).toBeCloseTo(b.fill * 100, 3)
  expect(styles.fullBar).toMatch(/srgb 0\.07\d* 0\.50/)
  const red = (c: string) => {
    const [r, g, b] = c.match(/[\d.]+/g)!.map(Number)
    return r > g + 60 && r > b + 60
  }
  for (const key of ['cell', 'header', 'summary'] as const) expect(red(styles[key]), key).toBe(true)
  expect(styles.bar).toMatch(/srgb 0\.85/)
  expect(styles.row).toMatch(/inset/)
  expect(styles.current).not.toBe('none')
  expect(styles.other).toBe('none')
  for (const key of ['stickyName', 'stickyHead'] as const) expect(styles[key], key).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  // The row being edited is highlighted, week cells too, and its button outlined.
  const row = page.locator('tbody tr').nth(1)
  const before = await row.evaluate((tr) => [0, 2].map((i) => getComputedStyle(tr.children[i]).backgroundImage + getComputedStyle(tr.children[i]).backgroundColor))
  await row.locator('.cap-button').click()
  await expect(page.locator('tr.editing')).toHaveCount(1)
  const after = await page.locator('tr.editing').evaluate((tr) => [0, 2].map((i) => getComputedStyle(tr.children[i]).backgroundImage + getComputedStyle(tr.children[i]).backgroundColor))
  expect(after[0]).not.toBe(before[0])
  expect(after[1]).not.toBe(before[1])
  await expect(page.locator('tr.editing .cap-button')).toHaveCSS('border-top-style', 'solid')
  // Errors are red: the editor's message and its field's border, and the "?".
  await page.getByRole('textbox', { name: /Weekly hours for/ }).fill('abc')
  await page.getByRole('button', { name: 'Save' }).click()
  const errors = await page.evaluate(() => {
    document.querySelector('.cap-button')!.insertAdjacentHTML('beforeend', '<span class="unconfirmed"> ?</span>')
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!)
    return [cs('.cap-editor .hint.error').color, cs('.cap-editor input[aria-invalid="true"]').borderTopColor, cs('.cap-button .unconfirmed').color]
  })
  for (const c of errors) expect(red(c), c).toBe(true)
})

// A failed load's banner is marked red.
test('the banner of a failed load is drawn in red', async ({ page }) => {
  await page.route('**/api/capacity**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"could not load capacity"}' }))
  await page.goto(`/?from=${FIXTURE.from}&to=${FIXTURE.to}`)
  const banner = page.locator('.banner')
  await expect(banner).toBeVisible()
  const [border, tint] = await banner.evaluate((b) => [getComputedStyle(b).borderTopColor, getComputedStyle(b).backgroundColor])
  const [r, g, b] = border.match(/[\d.]+/g)!.map(Number)
  expect(r > g + 60 && r > b + 60, border).toBe(true)
  expect(tint).not.toMatch(/rgba\(0, 0, 0, 0\)/)
})

// When its window comes back, the browser gives focus back where it was, with
// no relatedTarget, like Shift+Tab from its own UI: that is no step of the
// manager's, and focus stays on the same person.
test('focus given back when the window returns stays on the same person', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const scroller = page.locator('.scroller')
  await scroller.evaluate((el) => (el.scrollTop = 4400))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(4400)
  const id = (await buttonsInView(page))[1]
  const button = page.locator(`.cap-button[data-person-id="${id}"]`)
  await button.focus()
  // Its row leaves the view but stays rendered.
  await scroller.evaluate((el) => (el.scrollTop += 200))
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(4600)
  await button.evaluate((b) => {
    window.dispatchEvent(new Event('blur'))
    ;(b as HTMLElement).blur()
    ;(b as HTMLElement).focus({ preventScroll: true })
  })
  await expect(button).toBeFocused()
})

// The rows that stand in for the ones not rendered are hidden from screen readers.
test('the spacer rows are hidden from screen readers', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.locator('.scroller').evaluate((el) => (el.scrollTop = 3000))
  const spacers = page.locator('tr.spacer')
  await expect(spacers).toHaveCount(2)
  for (const spacer of await spacers.all()) await expect(spacer).toHaveAttribute('aria-hidden', 'true')
})

// Scrolling a focused button's row out of the rendered window removes it:
// focus stays in the grid, not on the page.
test('focus stays in the grid when its row is scrolled away', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await page.locator('.cap-button').first().focus()
  await page.locator('.scroller').evaluate((el) => (el.scrollTop = 8000))
  await expect(page.locator('.scroller')).toBeFocused()
})

// The grid renders only the rows near the view, in a box that scrolls, so it
// can't print itself: in print it is left out, and a note says so.
test('printing leaves the grid out and says why', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await expect(page.locator('.print-note')).toBeHidden()
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.scroller')).toBeHidden()
  await expect(page.locator('.print-note')).toBeVisible()
  await expect(page.locator('.print-note')).toContainText("The grid isn't printed")
  await expect(page.locator('.summary')).toBeVisible()
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
  await expect(page.locator('thead th.week')).toHaveCount(53, { timeout: 15_000 })
  const labels = await weekLabels(page)
  expect(labels[0]).toBe('12 Oct 2026')
  expect(labels[52]).toBe('11 Oct 2027')
  await expect(page.locator('tbody td.alloc').first()).toHaveAttribute('title', /week of 12 Oct 2026:/)
})
