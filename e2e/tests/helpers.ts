import { expect, type Locator, type Page, type Request, type Route } from '@playwright/test'

export const FIXTURE = { from: '2025-12-29', to: '2026-01-18' }
export const FIXTURE_WEEKS = ['29 Dec', '5 Jan', '12 Jan']

export function rangeURL(from: string, to: string) {
  return `/?from=${from}&to=${to}`
}

/** Opens a range and waits until its week headers are on screen. */
export async function openRange(page: Page, from: string, to: string, weeks: string[]) {
  await page.goto(rangeURL(from, to))
  await expectWeeks(page, weeks)
}

/** The date line of every week header, e.g. ["29 Dec", "5 Jan", "12 Jan"]. */
export function weekHeaders(page: Page): Locator {
  return page.locator('thead th.week')
}

export async function weekLabels(page: Page): Promise<string[]> {
  const texts = await weekHeaders(page).allInnerTexts()
  return texts.map((t) => t.split('\n')[0].trim())
}

export async function expectWeeks(page: Page, weeks: string[]) {
  await expect.poll(() => weekLabels(page)).toEqual(weeks)
}

/** The over-count line of every week header, e.g. ["39 over", "15 over", "none over"]. */
export async function overCounts(page: Page): Promise<string[]> {
  const texts = await weekHeaders(page).allInnerTexts()
  return texts.map((t) => t.split('\n').slice(1).join(' ').trim())
}

/** Rendered person rows (virtualisation spacers excluded). */
export function personRows(page: Page): Locator {
  return page.locator('tbody tr:not(.spacer)')
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function rowFor(page: Page, name: string): Locator {
  return personRows(page).filter({
    has: page.locator('th.name', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }),
  })
}

/** The capacity button in a person's row ("40h"). */
export function capButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^Weekly hours for ${escapeRegExp(name)}: .*Edit$`) })
}

/**
 * Text of an allocation cell as "<hours>[ +<over>]": "45 +5", "40", "–".
 * Independent of layout (the delta may sit on its own line or inline).
 */
export async function cellText(cell: Locator): Promise<string> {
  const raw = ((await cell.textContent()) ?? '').replace(/\s+/g, '')
  const m = raw.match(/^([^+]*)(\+.*)?$/)
  return m ? [m[1], m[2]].filter(Boolean).join(' ') : raw
}

export function allocCell(page: Page, name: string, weekIndex: number): Locator {
  return rowFor(page, name).locator('td.alloc').nth(weekIndex)
}

export async function expectCell(page: Page, name: string, weekIndex: number, text: string, status: string) {
  const cell = allocCell(page, name, weekIndex)
  await expect(cell).toHaveClass(new RegExp(`(^|\\s)${status}(\\s|$)`))
  await expect.poll(() => cellText(cell)).toBe(text)
}

/** "N" from "… · N of M people over capacity in at least one week". */
export async function summaryCounts(page: Page): Promise<{ over: number; total: number }> {
  const text = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  const m = text.match(/(\d+) of (\d+) people over capacity/)
  if (!m) throw new Error(`summary has no over-capacity count: ${JSON.stringify(text)}`)
  return { over: Number(m[1]), total: Number(m[2]) }
}

export function editor(page: Page): Locator {
  return page.locator('.cap-editor')
}

export function editorInput(page: Page, name: string): Locator {
  return page.getByLabel(`Weekly hours for ${name}`, { exact: true })
}

export function editorHint(page: Page): Locator {
  return page.locator('.cap-editor .hint')
}

export async function openEditor(page: Page, name: string) {
  await capButton(page, name).click()
  await expect(editorInput(page, name)).toBeVisible()
}

export function isCapacityGet(req: Request) {
  return req.method() === 'GET' && new URL(req.url()).pathname === '/api/capacity'
}

export function isPatch(req: Request, id?: number) {
  const path = new URL(req.url()).pathname
  return req.method() === 'PATCH' && (id === undefined ? path.startsWith('/api/people/') : path === `/api/people/${id}`)
}

export function capacityFrom(req: Request): string | null {
  return new URL(req.url()).searchParams.get('from')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A promise plus its resolver, to hold a routed request until the test lets it go. */
export function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

/** Fulfil, ignoring the error raised if the page already aborted the request. */
export async function settle(action: () => Promise<void>) {
  try {
    await action()
  } catch (err) {
    const msg = String(err)
    if (!/aborted|closed|Target page|already handled|has been closed/i.test(msg)) throw err
  }
}

export type Handler = (route: Route, req: Request) => Promise<void>

/**
 * One route for the whole API; `handler` returns true when it handled the
 * request, otherwise the request goes to the real server.
 */
export async function routeApi(page: Page, handler: (route: Route, req: Request) => Promise<boolean>) {
  await page.route('**/api/**', async (route) => {
    const handled = await handler(route, route.request())
    if (!handled) await settle(() => route.fallback())
  })
}
