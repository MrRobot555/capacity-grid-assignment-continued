import type { CapacityResponse, Person } from './api'
import type { ISODate } from './dates'

// The grid's data, as a reducer so the rules that keep it honest are testable
// without rendering anything.
//
// Two kinds of data live here, kept apart on purpose:
//  - allocations, which belong to a range and are replaced on every load;
//  - people (name, weekly hours), which belong to the person and are what an
//    edit changes. Everything the grid shows about capacity — colours, the
//    "over" counts, the utilisation bars — is derived from these at render, so
//    updating one person's weeklyHours updates every number that depends on it.

export type Status = 'over' | 'full' | 'under' | 'none'

// Classify on the same two decimals the grid displays, so a cell never shows
// "40" against "40h" in red (capacity 39.999) or "+0" over.
export function allocationStatus(allocated: number, capacity: number): Status {
  const a = Math.round(allocated * 100)
  const c = Math.round(capacity * 100)
  if (a > c) return 'over'
  if (a === 0) return 'none'
  if (a === c) return 'full'
  return 'under'
}

export type Loaded = {
  key: string
  weeks: ISODate[]
  rows: { id: number; allocated: number[] }[]
}

export type State = {
  /** The range the grid is asking for. */
  requestedKey: string | null
  /** The request it is waiting for. Responses to any other request are dropped. */
  requestedAt: number | null
  loading: boolean
  error: string | null
  /** The last range that loaded. Kept on screen while the next one loads or fails. */
  data: Loaded | null
  people: Record<number, { name: string; weeklyHours: number }>
  /** When each person's latest save was confirmed, on the same clock as `issuedAt`. */
  confirmedAt: Record<number, number>
}

export type Action =
  | { type: 'fetchStarted'; key: string; issuedAt: number }
  | { type: 'fetchSucceeded'; key: string; issuedAt: number; response: CapacityResponse }
  | { type: 'fetchFailed'; key: string; issuedAt: number; error: string }
  | { type: 'saveConfirmed'; person: Person; confirmedAt: number }

export const initialState: State = {
  requestedKey: null,
  requestedAt: null,
  loading: false,
  error: null,
  data: null,
  people: {},
  confirmedAt: {},
}

// The database orders by name, but the Postgres image runs on musl, whose
// collation is byte order: "Öztürk" sorts after "Yilmaz". Order for people.
const byName = new Intl.Collator(undefined, { sensitivity: 'base' })

export function rangeKey(from: ISODate, to: ISODate): string {
  return `${from}..${to}`
}

export function capacityReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'fetchStarted':
      return { ...state, requestedKey: action.key, requestedAt: action.issuedAt, loading: true, error: null }

    case 'fetchSucceeded': {
      // Matching the request, not just the range: after A → B → A, the first
      // request for A is as stale as the one for B.
      if (action.issuedAt !== state.requestedAt) return state
      const people = { ...state.people }
      for (const p of action.response.people) {
        // A load that was sent before a save was confirmed can carry the old
        // weekly hours. The confirmed save is newer, so it wins.
        const confirmed = state.confirmedAt[p.id]
        const keepLocal = confirmed !== undefined && confirmed > action.issuedAt && p.id in people
        people[p.id] = { name: p.name, weeklyHours: keepLocal ? people[p.id].weeklyHours : p.weeklyHours }
      }
      return {
        ...state,
        loading: false,
        error: null,
        people,
        data: {
          key: action.key,
          weeks: action.response.weeks,
          rows: [...action.response.people]
            .sort((a, b) => byName.compare(a.name, b.name) || a.id - b.id)
            .map((p) => ({ id: p.id, allocated: p.allocated })),
        },
      }
    }

    case 'fetchFailed':
      if (action.issuedAt !== state.requestedAt) return state
      return { ...state, loading: false, error: action.error }

    case 'saveConfirmed': {
      const { id, name, weeklyHours } = action.person
      return {
        ...state,
        people: { ...state.people, [id]: { name, weeklyHours } },
        confirmedAt: { ...state.confirmedAt, [id]: action.confirmedAt },
      }
    }
  }
}

export const MAX_WEEKLY_HOURS = 168

/** The typed capacity as a number, or the reason it can't be saved. */
export function parseWeeklyHours(draft: string): number | string {
  const text = draft.trim()
  // Number('') is 0: an emptied field must not quietly save zero capacity.
  if (text === '') return 'Enter the weekly hours.'
  const hours = Number(text)
  if (!Number.isFinite(hours)) return 'Enter a number of hours.'
  if (hours < 0 || hours > MAX_WEEKLY_HOURS) return `Weekly hours must be between 0 and ${MAX_WEEKLY_HOURS}.`
  return hours
}
