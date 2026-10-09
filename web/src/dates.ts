// Dates travel as 'YYYY-MM-DD' strings. All arithmetic is done in UTC, so a
// result never depends on the viewer's time zone or a daylight-saving change.
// (new Date('2025-12-29') read back with local getters is the 28th west of
// UTC, and adding 7 × 24h across a DST change lands on the wrong day.)

export type ISODate = string

const DAY_MS = 86_400_000

function toUTC(date: ISODate): number {
  const [y, m, d] = date.split('-').map(Number)
  // Not Date.UTC: it reads years 0–99 as 1900–1999, and a date input emits
  // years like 0002 and 0020 while someone types "2026".
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d)
  return t.getTime()
}

function fromUTC(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10)
}

export function isISODate(value: string | null): value is ISODate {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromUTC(toUTC(value)) === value
}

/** Years a capacity plan can sensibly mean; anything else is a half-typed date. */
const MIN_YEAR = 2000
const MAX_YEAR = 2099

export function isSupportedDate(value: string | null): value is ISODate {
  if (!isISODate(value)) return false
  const year = Number(value.slice(0, 4))
  return year >= MIN_YEAR && year <= MAX_YEAR
}

export const MIN_DATE = `${MIN_YEAR}-01-01`
export const MAX_DATE = `${MAX_YEAR}-12-31`

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * DAY_MS)
}

export function mondayOf(date: ISODate): ISODate {
  const sinceMonday = (new Date(toUTC(date)).getUTCDay() + 6) % 7
  return addDays(date, -sinceMonday)
}

/** Number of weeks from the week containing `from` to the week containing `to`, inclusive. */
export function weekCount(from: ISODate, to: ISODate): number {
  return Math.round((toUTC(mondayOf(to)) - toUTC(mondayOf(from))) / (7 * DAY_MS)) + 1
}

/** The viewer's calendar date: local, because "today" is wherever they are. */
export function todayISO(now = new Date()): ISODate {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const shortFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const longFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** "29 Dec" */
export function formatShort(date: ISODate): string {
  return shortFormat.format(toUTC(date))
}

/** "29 Dec 2025" */
export function formatLong(date: ISODate): string {
  return longFormat.format(toUTC(date))
}

/** A range of whole weeks: `from` is a Monday, `to` is the Sunday of the last week. */
export type WeekRange = { from: ISODate; to: ISODate }

export function weekRange(from: ISODate, to: ISODate): WeekRange {
  const start = mondayOf(from)
  const end = addDays(mondayOf(to), 6)
  return end < start ? { from: start, to: addDays(start, 6) } : { from: start, to: end }
}

export function weeksFrom(from: ISODate, weeks: number): WeekRange {
  const start = mondayOf(from)
  return { from: start, to: addDays(start, weeks * 7 - 1) }
}

/** The longest range the API serves in one request. */
export const MAX_WEEKS = 106

export function limitWeeks(range: WeekRange, max = MAX_WEEKS): WeekRange {
  return weekCount(range.from, range.to) <= max ? range : weeksFrom(range.from, max)
}

export function shiftWeeks(range: WeekRange, weeks: number): WeekRange {
  return { from: addDays(range.from, weeks * 7), to: addDays(range.to, weeks * 7) }
}
