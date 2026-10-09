import { afterEach, describe, expect, it } from 'vitest'
import {
  addDays,
  formatShort,
  isISODate,
  isSupportedDate,
  limitWeeks,
  MAX_WEEKS,
  mondayOf,
  shiftWeeks,
  todayISO,
  weekCount,
  weekRange,
  weeksFrom,
} from './dates'

// Date bugs hide in the viewer's time zone, so run the sensitive cases in zones
// on both sides of UTC. Node picks up a change to process.env.TZ immediately.
// (Declared here rather than pulling Node's types into the browser app.)
declare const process: { env: { TZ?: string } }
const originalTZ = process.env.TZ
afterEach(() => {
  process.env.TZ = originalTZ
})

describe.each(['America/Los_Angeles', 'Europe/Budapest', 'Pacific/Kiritimati'])('in %s', (tz) => {
  it('snaps any day to its Monday, across the year boundary', () => {
    process.env.TZ = tz
    expect(mondayOf('2025-12-29')).toBe('2025-12-29') // Monday
    expect(mondayOf('2026-01-01')).toBe('2025-12-29') // Thursday, new year
    expect(mondayOf('2026-01-04')).toBe('2025-12-29') // Sunday belongs to the week before
  })

  it('moves by whole weeks across a DST change', () => {
    process.env.TZ = tz
    // Europe falls back on 2026-10-25, the US on 2026-11-01.
    const range = weeksFrom('2026-10-19', 2)
    expect(shiftWeeks(range, 1)).toEqual({ from: '2026-10-26', to: '2026-11-08' })
    expect(addDays('2026-10-24', 7)).toBe('2026-10-31')
  })

  it('formats the date it was given, not the day before', () => {
    process.env.TZ = tz
    expect(formatShort('2025-12-29')).toBe('29 Dec')
  })

  it("reads today from the viewer's calendar, not UTC", () => {
    process.env.TZ = tz
    // Just after midnight local time is still the previous day in UTC east of it.
    expect(todayISO(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01')
  })
})

describe('week ranges', () => {
  it('widens any two dates to whole weeks', () => {
    expect(weekRange('2025-12-31', '2026-01-16')).toEqual({ from: '2025-12-29', to: '2026-01-18' })
    expect(weekCount('2025-12-29', '2026-01-18')).toBe(3)
  })

  it('never produces a backwards range', () => {
    expect(weekRange('2026-01-12', '2026-01-01')).toEqual({ from: '2026-01-12', to: '2026-01-18' })
  })
})

// Exhaustive rather than hand-picked: every day of five years, in zones with
// odd offsets and DST rules, against a day sequence generated in pure UTC
// (which has no DST and no local-time ambiguity, so it can be trusted).
describe.each(['America/Los_Angeles', 'Europe/Budapest', 'Pacific/Kiritimati', 'America/St_Johns', 'Australia/Lord_Howe'])(
  'every day 2024–2028 in %s',
  (tz) => {
    it('agrees with plain UTC day arithmetic', () => {
      process.env.TZ = tz
      const DAY = 86_400_000
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      const failures: string[] = []
      for (let ms = Date.UTC(2024, 0, 1); ms <= Date.UTC(2028, 11, 31); ms += DAY) {
        const day = iso(ms)
        const monday = iso(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY)
        const checks: [string, unknown, unknown][] = [
          ['mondayOf', mondayOf(day), monday],
          ['addDays +7', addDays(day, 7), iso(ms + 7 * DAY)],
          ['addDays -1', addDays(day, -1), iso(ms - DAY)],
          ['weekRange', weekRange(day, day), { from: monday, to: iso(Date.parse(monday) + 6 * DAY) }],
          ['weekCount', weekCount(day, day), 1],
          ['isISODate', isISODate(day), true],
          ['formatShort day', formatShort(day).split(' ')[0], String(new Date(ms).getUTCDate())],
        ]
        for (const [name, got, want] of checks) {
          if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${day} ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
        }
      }
      expect(failures.slice(0, 5)).toEqual([])
    })
  },
)

describe('dates a person can type', () => {
  // A date input emits every intermediate year while you type "2026":
  // 0002-…, 0020-…, 0202-…, 2026-…
  it('does not read years below 100 as 19xx', () => {
    expect(addDays('0002-01-05', 1)).toBe('0002-01-06')
    expect(isISODate('0099-12-31')).toBe(true)
  })

  it('only supports years a capacity plan can mean', () => {
    expect(isSupportedDate('0002-01-05')).toBe(false)
    expect(isSupportedDate('0202-01-05')).toBe(false)
    expect(isSupportedDate('2026-01-05')).toBe(true)
    expect(isSupportedDate('2026-02-30')).toBe(false)
  })

  it('caps a range at the longest the API serves', () => {
    // 106 is maxWeeks in api/capacity.go; a literal, so the two can't drift apart unnoticed.
    expect(MAX_WEEKS).toBe(106)
    expect(weekCount('2026-01-05', limitWeeks({ from: '2026-01-05', to: '2030-01-06' }).to)).toBe(106)
    expect(limitWeeks({ from: '2026-01-05', to: '2026-01-18' })).toEqual({ from: '2026-01-05', to: '2026-01-18' })
  })
})
