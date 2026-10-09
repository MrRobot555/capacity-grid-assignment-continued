import { describe, expect, it } from 'vitest'
import type { CapacityResponse } from './api'
import {
  allocationStatus,
  capacityReducer,
  initialState,
  parseWeeklyHours,
  type Action,
  type State,
} from './capacityState'

const response = (deeHours: number): CapacityResponse => ({
  weeks: ['2026-01-05', '2026-01-12'],
  people: [
    { id: 4, name: 'Dee Okafor', weeklyHours: deeHours, allocated: [45, 40] },
    { id: 1, name: 'Ana Ferreira', weeklyHours: 40, allocated: [0, 30] },
  ],
})

const run = (...actions: Action[]): State => actions.reduce(capacityReducer, initialState)

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
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(40) },
    )
    expect(state.data).toBeNull()
    expect(state.loading).toBe(true)
  })

  it('drops an older request for the same range: A → B → back to A', () => {
    // Abort normally stops the first A request, but the reducer must not depend on it.
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'fetchStarted', key: 'A', issuedAt: 3 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 3, response: response(40) },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(10) },
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
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(40) },
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
        response: {
          weeks: ['2026-01-05'],
          people: [
            { id: 2, name: 'Fatima Yilmaz', weeklyHours: 40, allocated: [0] },
            { id: 1, name: 'Fatima Öztürk', weeklyHours: 40, allocated: [0] },
          ],
        },
      },
    )
    expect(state.data?.rows.map((r) => r.id)).toEqual([1, 2])
  })

  it('applies a confirmed save to the person, leaving allocations alone', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(40) },
      { type: 'saveConfirmed', person: { id: 4, name: 'Dee Okafor', weeklyHours: 50 }, confirmedAt: 2 },
    )
    expect(state.people[4].weeklyHours).toBe(50)
    expect(state.data?.rows.find((r) => r.id === 4)?.allocated).toEqual([45, 40])
  })

  it('does not let a load sent before a save overwrite it', () => {
    // Navigate (load issued at 2), save confirms at 3, then the load arrives
    // carrying the old value.
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(40) },
      { type: 'fetchStarted', key: 'B', issuedAt: 2 },
      { type: 'saveConfirmed', person: { id: 4, name: 'Dee Okafor', weeklyHours: 50 }, confirmedAt: 3 },
      { type: 'fetchSucceeded', key: 'B', issuedAt: 2, response: response(40) },
    )
    expect(state.data?.key).toBe('B')
    expect(state.people[4].weeklyHours).toBe(50)
  })

  it('takes the server value from a load sent after the save', () => {
    const state = run(
      { type: 'fetchStarted', key: 'A', issuedAt: 1 },
      { type: 'fetchSucceeded', key: 'A', issuedAt: 1, response: response(40) },
      { type: 'saveConfirmed', person: { id: 4, name: 'Dee Okafor', weeklyHours: 50 }, confirmedAt: 2 },
      { type: 'fetchStarted', key: 'B', issuedAt: 3 },
      // Someone else changed it again since: the newer load wins.
      { type: 'fetchSucceeded', key: 'B', issuedAt: 3, response: response(36) },
    )
    expect(state.people[4].weeklyHours).toBe(36)
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
    expect(parseWeeklyHours('abc')).toBeTypeOf('string')
  })
})
