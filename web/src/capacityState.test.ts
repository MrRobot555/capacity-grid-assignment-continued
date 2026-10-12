import { describe, expect, it } from 'vitest'
import type { CapacityResponse } from './api'
import {
  allocationStatus,
  capacityReducer,
  capacityView,
  certaintyOf,
  formatHours,
  initialState,
  parseWeeklyHours,
  type Action,
  type State,
} from './capacityState'

const response = (deeHours: number): CapacityResponse => ({
  weeks: ['2026-01-05', '2026-01-12'],
  people: [
    { id: 4, name: 'Dee Okafor', weeklyHours: deeHours, version: 'v1', allocated: [45, 40] },
    { id: 1, name: 'Ana Ferreira', weeklyHours: 40, version: 'v1', allocated: [0, 30] },
  ],
})

const run = (...actions: Action[]): State => actions.reduce(capacityReducer, initialState)

/** A load of range B, sent at `issuedAt` and answered just after. */
const load = (issuedAt: number, res: CapacityResponse, key = 'B'): Action[] => [
  { type: 'fetchStarted', key, issuedAt },
  { type: 'fetchSucceeded', key, issuedAt, receivedAt: issuedAt + 0.5, response: res },
]

/** Dee's row at another version. */
const deeAt = (hours: number, version: string): CapacityResponse => ({
  ...response(hours),
  people: response(hours).people.map((p) => (p.id === 4 ? { ...p, version } : p)),
})

/** The answer to a save of Dee sent on `over` at `at`: stored (200) or not (412). */
const saved = (
  hours: number,
  version: string,
  o: { over: string; at: number; stored?: boolean; receivedAt?: number },
): Action => ({
  type: 'saveAnswered',
  person: { id: 4, name: 'Dee Okafor', weeklyHours: hours, version },
  stored: o.stored ?? true,
  sentOn: o.over,
  sentAt: o.at,
  receivedAt: o.receivedAt ?? o.at + 0.5,
})

describe('allocationStatus', () => {
  it('classifies against capacity', () => {
    expect(allocationStatus(45, 40)).toBe('over')
    expect(allocationStatus(40, 40)).toBe('full')
    expect(allocationStatus(30, 40)).toBe('under')
    expect(allocationStatus(0, 40)).toBe('none')
  })

  it('classifies on the two decimals the grid shows, so "40 of 40h" is never red', () => {
    expect(allocationStatus(40, 39.999)).toBe('full')
    expect(allocationStatus(40.004, 40)).toBe('full')
    expect(allocationStatus(40.01, 40)).toBe('over')
  })

  it('classifies the value it displays, half-hundredths included', () => {
    // 20.005 is shown as "20": against 20 allocated that is full, not under.
    expect(formatHours(20.005)).toBe('20')
    expect(allocationStatus(20, 20.005)).toBe('full')
    // 0.995 is shown as "0.99": against 1 allocated that is over.
    expect(formatHours(0.995)).toBe('0.99')
    expect(allocationStatus(1, 0.995)).toBe('over')
  })

  it('says how sure it is about a capacity', () => {
    expect(capacityView(40, 'certain')).toEqual({ text: '40h', certain: true, note: null, doubt: null })
    expect(capacityView(40, 'retrying')).toMatchObject({ certain: false, note: expect.stringMatching(/Sending it again/), doubt: 'last save not confirmed' })
    expect(capacityView(40, 'unknown')).toMatchObject({ certain: false, note: expect.stringMatching(/may hold a different value/), doubt: 'last save not confirmed' })
    expect(capacityView(40, 'checking')).toMatchObject({ certain: false, note: expect.stringMatching(/may hold a newer value/), doubt: 'may not be the latest' })
  })

  it('treats any allocation against zero capacity as over, without dividing', () => {
    expect(allocationStatus(20, 0)).toBe('over')
    expect(allocationStatus(0, 0)).toBe('none')
  })
})

describe('capacityReducer', () => {
  it('drops a response for a range that is no longer requested', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, receivedAt: 1.5, response: response(40) },
    )
    expect(state.data).toBeNull()
    expect(state.loading).toBe(true)
  })

  it("clears the last load's error when the next load starts", () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchFailed', key: 'A', issuedAt: 1, error: 'The server could not handle the request (502)' },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
    )
    expect(state.error).toBeNull()
  })

  it('drops an older request for the same range: A → B → back to A', () => {
    // Abort normally stops the first A request, but the reducer must not depend on it.
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'fetchStarted', key: 'A', issuedAt: 3 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 3, receivedAt: 3.5, response: response(40) },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, receivedAt: 1.5, response: response(10) },
    )
    expect(state.people[4].weeklyHours).toBe(40)
  })

  it('drops a failure for a range that is no longer requested', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'fetchFailed', key: 'A', issuedAt: 1, error: 'boom' },
    )
    expect(state.error).toBeNull()
    expect(state.loading).toBe(true)
  })

  it('keeps the previous range on screen when a load fails', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, receivedAt: 1.5, response: response(40) },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'fetchFailed', key: 'B', issuedAt: 2, error: 'boom' },
    )
    expect(state.data?.key).toBe('A')
    expect(state.error).toBe('boom')
    expect(state.loading).toBe(false)
  })

  it('orders people by name for humans, not by byte', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      {
        type: 'fetchSucceeded',
        key: 'A',
        issuedAt: 1,
        receivedAt: 1.5,
        response: {
          weeks: ['2026-01-05'],
          people: [
            { id: 2, name: 'Fatima Yilmaz', weeklyHours: 40, version: 'v1', allocated: [0] },
            { id: 1, name: 'Fatima Öztürk', weeklyHours: 40, version: 'v1', allocated: [0] },
          ],
        },
      },
    )
    expect(state.data?.rows.map((r) => r.id)).toEqual([1, 2])
  })

  it('applies a stored save to the person, leaving allocations alone', () => {
    const state = run(...load(1, response(40)), saved(50, 'v2', { over: 'v1', at: 2 }))
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 50, version: 'v2' })
    expect(state.data?.rows.find((r) => r.id === 4)?.allocated).toEqual([45, 40])
  })

  it('keeps our save over a load sent before it that shows the version it was written over', () => {
    const state = run(
      ...load(1, response(40)),
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      saved(50, 'v2', { over: 'v1', at: 3 }),
      { type: 'fetchSucceeded', key: 'B', issuedAt: 2, receivedAt: 5, response: response(40) },
    )
    expect(state.data?.key).toBe('B')
    // The whole row, version included: a stale version beside the kept hours
    // would make the next save a false "changed on the server".
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 50, version: 'v2' })
    expect(certaintyOf(state, 4)).toBe('certain')
  })

  it('keeps a person unsure through a load that still shows the version the save was sent on', () => {
    // At that version, a lost attempt of the save can still land.
    for (const doubt of [{ type: 'saveRetrying', id: 4, version: 'v1', value: 50 }, { type: 'saveGaveUp', id: 4, version: 'v1', value: 50 }] as Action[]) {
      const state = run(doubt, ...load(5, response(40)))
      expect(certaintyOf(state, 4)).not.toBe('certain')
      expect(state.people[4].weeklyHours).toBe(40) // the load still updates the value shown
    }
  })

  it('takes a newer version from a later load (someone else saved meanwhile)', () => {
    const state = run(...load(1, response(40)), ...load(3, deeAt(30, 'v3')))
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 30, version: 'v3' })
  })

  it("keeps the row's version from loads and from saves, for the next If-Match", () => {
    const loaded = run(...load(1, response(40)))
    expect(loaded.people[4].version).toBe('v1')
    const stored = capacityReducer(loaded, saved(50, 'v9', { over: 'v1', at: 2 }))
    expect(stored.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 50, version: 'v9' })
  })

  it('ends the doubt when a load shows the row at another version', () => {
    // Under If-Match the doubtful save can no longer land; the load is the truth.
    const state = run({ type: 'saveGaveUp', id: 4, version: 'v1', value: 50 }, ...load(5, deeAt(30, 'v7')))
    expect(certaintyOf(state, 4)).toBe('certain')
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 30, version: 'v7' })
  })

  it('never records a doubt about a version the row has already moved past', () => {
    const late = capacityReducer(run(...load(1, response(40))), { type: 'saveGaveUp', id: 4, version: 'v0', value: 50 })
    expect(certaintyOf(late, 4)).toBe('certain')
  })

  it('keeps every doubtful value on the same version: only one of them can land', () => {
    const state = run(
      { type: 'saveGaveUp', id: 4, version: 'v1', value: 24 },
      { type: 'saveGaveUp', id: 4, version: 'v1', value: 20 },
    )
    expect(state.unsure[4]).toEqual({ state: 'unknown', version: 'v1', values: [24, 20] })
  })

  it("keeps each person's doubt to themselves", () => {
    const state = run(
      { type: 'saveRetrying', id: 4, version: 'v1', value: 50 },
      { type: 'saveGaveUp', id: 1, version: 'v1', value: 36 },
      // A stored save of Ana says nothing about Dee.
      { type: 'saveAnswered', person: { id: 1, name: 'Ana Ferreira', weeklyHours: 36, version: 'v2' }, stored: true, sentOn: 'v1', sentAt: 2, receivedAt: 3 },
    )
    expect(certaintyOf(state, 4)).toBe('retrying')
    expect(certaintyOf(state, 1)).toBe('certain')
  })

  it('ends the doubt on a version with any answer to a save sent on it, stored or not', () => {
    for (const stored of [true, false]) {
      const state = run(
        ...load(1, response(40)),
        { type: 'saveGaveUp', id: 4, version: 'v1', value: 50 },
        saved(40, 'v2', { over: 'v1', at: 3, stored }),
      )
      expect(certaintyOf(state, 4)).toBe('certain')
    }
  })

  it("ignores a save's answer whose row is known to come before the row shown", () => {
    // A 412 read v2/60; before it arrived, a load showed v2, then a later load v3/70.
    const state = run(
      ...load(1, response(40)),
      ...load(3, deeAt(60, 'v2')),
      ...load(5, deeAt(70, 'v3')),
      saved(60, 'v2', { over: 'v1', at: 2, stored: false, receivedAt: 7 }),
    )
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 70, version: 'v3' })
    expect(certaintyOf(state, 4)).toBe('certain')
  })

  it('ignores our late stored row when the row shown came after the version ours was written over', () => {
    // Ours stored v2 over v1; a load sent after v1 was known showed v3 first.
    const state = run(...load(1, response(40)), ...load(3, deeAt(60, 'v3')), saved(50, 'v2', { over: 'v1', at: 2, receivedAt: 6 }))
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 60, version: 'v3' })
  })

  it('takes a row sent after the shown version was known, whatever came between', () => {
    // Two stored saves of ours (v2, v3), then a 412 sent after v3 was known
    // shows another manager's v4.
    const state = run(
      ...load(1, response(40)),
      saved(45, 'v2', { over: 'v1', at: 2 }),
      saved(50, 'v3', { over: 'v2', at: 4 }),
      saved(60, 'v4', { over: 'v3', at: 6, stored: false }),
    )
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 60, version: 'v4' })
  })

  it("keeps the row shown when an answer can't be placed, marks it, and asks for the range again", () => {
    // A load sent before our two saves shows v4: it may be older than ours or newer.
    const unplaced = run(
      ...load(1, response(40)),
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      saved(45, 'v2', { over: 'v1', at: 3 }),
      saved(50, 'v3', { over: 'v2', at: 5 }),
      { type: 'fetchSucceeded', key: 'B', issuedAt: 2, receivedAt: 7, response: deeAt(60, 'v4') },
    )
    expect(unplaced.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 50, version: 'v3' })
    expect(certaintyOf(unplaced, 4)).toBe('checking')
    expect(unplaced.recheck).toBe(1)
    // A load sent after that settles it.
    const settled = load(8, deeAt(60, 'v4')).reduce(capacityReducer, unplaced)
    expect(settled.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 60, version: 'v4' })
    expect(certaintyOf(settled, 4)).toBe('certain')
  })

  it('stays marked through answers sent before the unplaced one arrived', () => {
    const unplaced = run(
      ...load(1, response(40)),
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      saved(50, 'v2', { over: 'v1', at: 3 }),
      { type: 'fetchSucceeded', key: 'B', issuedAt: 2, receivedAt: 5, response: deeAt(60, 'v4') },
    )
    const sameSentEarlier = capacityReducer(unplaced, saved(50, 'v2', { over: 'v1', at: 4, stored: false, receivedAt: 6 }))
    expect(certaintyOf(sameSentEarlier, 4)).toBe('checking')
  })

  it('takes the shown version with other data as a repeat: by time when it can, otherwise marked', () => {
    // The database was re-created: v1 again, with other hours.
    const later = run(...load(1, deeAt(50, 'v1')), ...load(3, deeAt(40, 'v1')))
    expect(later.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 40, version: 'v1' })
    expect(certaintyOf(later, 4)).toBe('certain')
    const unplaced = run(...load(1, deeAt(50, 'v1')), saved(40, 'v1', { over: 'v0', at: 0.2, stored: false, receivedAt: 2 }))
    expect(unplaced.people[4].weeklyHours).toBe(50)
    expect(certaintyOf(unplaced, 4)).toBe('checking')
  })

  it('keeps when a version was first known: seeing it again is not news', () => {
    // v2 first shown by a load (answer at 3.5); our 412 re-shows it later (6).
    // A 412 sent at 4, after v2 was known, that shows v3 is newer.
    const state = run(
      ...load(1, response(40)),
      ...load(3, deeAt(60, 'v2')),
      saved(60, 'v2', { over: 'v1', at: 2, stored: false, receivedAt: 6 }),
      saved(70, 'v3', { over: 'v2', at: 4, stored: false, receivedAt: 7 }),
    )
    expect(state.people[4]).toEqual({ name: 'Dee Okafor', weeklyHours: 70, version: 'v3' })
  })
})

describe('parseWeeklyHours', () => {
  it('refuses an empty field instead of saving zero', () => {
    expect(parseWeeklyHours('')).toBeTypeOf('string')
    expect(parseWeeklyHours('   ')).toBeTypeOf('string')
  })

  it('accepts 0 to 168, including fractions', () => {
    expect(parseWeeklyHours('0')).toBe(0)
    expect(parseWeeklyHours('32.5')).toBe(32.5)
    expect(parseWeeklyHours('168')).toBe(168)
    expect(parseWeeklyHours('-1')).toBeTypeOf('string')
    expect(parseWeeklyHours('169')).toBeTypeOf('string')
    expect(parseWeeklyHours('168.5')).toBeTypeOf('string')
    expect(parseWeeklyHours('-0.5')).toBeTypeOf('string')
    expect(parseWeeklyHours('168.01')).toBeTypeOf('string')
    expect(parseWeeklyHours('-0.01')).toBeTypeOf('string')
    expect(parseWeeklyHours('abc')).toBeTypeOf('string')
  })

  it('takes a comma decimal as well as a point, and plain decimals only', () => {
    expect(parseWeeklyHours('12,5')).toBe(12.5)
    expect(parseWeeklyHours(' 37,5 ')).toBe(37.5)
    for (const text of ['1,000.5', '1,2,3', '0x10', '1e1', '12 5', '+5', '.']) expect(parseWeeklyHours(text), text).toBeTypeOf('string')
  })

  it('asks about a comma before exactly three digits instead of reading it as a decimal', () => {
    expect(parseWeeklyHours('1,000')).toMatch(/thousands separator/)
    expect(parseWeeklyHours('37,500')).toMatch(/thousands separator/)
    expect(parseWeeklyHours('37,50')).toBe(37.5)
    expect(parseWeeklyHours('1.000')).toBe(1)
    expect(parseWeeklyHours('-0')).toBe(0)
  })
})
