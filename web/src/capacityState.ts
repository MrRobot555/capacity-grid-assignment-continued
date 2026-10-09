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

/**
 * Hours as the grid shows them, in hundredths: the status, the "+N" overage
 * and the text all use this one value, so a cell never shows "40" against
 * "40h" in red (capacity 39.999), "+0" over, or disagree on a half-hundredth.
 */
export function hundredths(hours: number): number {
  return Math.round(Number(hours.toFixed(2)) * 100)
}

export function formatHours(hours: number): string {
  return String(hundredths(hours) / 100)
}

/**
 * How sure the grid can be about a person's capacity:
 *  - 'certain':  the last value the server confirmed or loaded;
 *  - 'retrying': a save of ours got no definite answer and is being sent again;
 *  - 'unknown':  we stopped sending it without a definite answer.
 */
export type Certainty = 'certain' | 'retrying' | 'unknown'

/**
 * How to show a person's capacity, and how sure we are about it. Every place
 * that shows a person's capacity uses this (button, its accessible name, its
 * tooltip, cell tooltips, the editor's title and notes), so none of them can
 * claim more than is known. Figures derived from capacities (the summary, the
 * week headers' "over" counts) are qualified in the summary instead.
 */
export type CapacityView = {
  /** "40h" */
  text: string
  certain: boolean
  /** Shown wherever the value is shown, when it isn't certain. */
  note: string | null
}

const NOTES: Record<Exclude<Certainty, 'certain'>, string> = {
  retrying: 'The last save got no answer yet. Sending it again until the server answers…',
  unknown:
    "The last save couldn't be confirmed, so the server may hold a different value. Saving again is safe and confirms it.",
}

export function capacityView(weeklyHours: number, certainty: Certainty): CapacityView {
  const text = `${formatHours(weeklyHours)}h`
  if (certainty === 'certain') return { text, certain: true, note: null }
  return { text, certain: false, note: NOTES[certainty] }
}

export function certaintyOf(state: Pick<State, 'unsure'>, id: number): Certainty {
  return state.unsure[id]?.state ?? 'certain'
}

export function allocationStatus(allocated: number, capacity: number): Status {
  const a = hundredths(allocated)
  const c = hundredths(capacity)
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

/**
 * Doubt about one person's capacity: saves sent on `version` (If-Match) whose
 * outcome we don't know, with the `values` they tried. Under If-Match at most
 * one of them can land, and only while the row is still at `version`. So the
 * doubt ends as soon as the row is seen at any other version (a load, a 412,
 * a confirmed save): no such save can land any more, and what is shown is the
 * truth. A doubt about a version already known to be past is never recorded.
 */
type Unsure = { state: 'retrying' | 'unknown'; version: string; values: number[] }

export type State = {
  /** The range the grid is asking for. */
  requestedKey: string | null
  /** The request it is waiting for. Responses to any other request are dropped. */
  requestedAt: number | null
  loading: boolean
  error: string | null
  /** The last range that loaded. Kept on screen while the next one loads or fails. */
  data: Loaded | null
  people: Record<number, { name: string; weeklyHours: number; version: string }>
  /** When each person's latest save was confirmed, on the same clock as `issuedAt`. */
  confirmedAt: Record<number, number>
  unsure: Record<number, Unsure>
}

export type Action =
  | { type: 'fetchStarted'; key: string; issuedAt: number }
  | { type: 'fetchSucceeded'; key: string; issuedAt: number; response: CapacityResponse }
  | { type: 'fetchFailed'; key: string; issuedAt: number; error: string }
  /** The server's row after a save: what it stored (200), or what it holds
   * now (412). Either is fresh, so it is applied. */
  | { type: 'saveConfirmed'; person: Person; confirmedAt: number }
  | { type: 'saveRetrying'; id: number; version: string; value: number }
  | { type: 'saveGaveUp'; id: number; version: string; value: number }

export const initialState: State = {
  requestedKey: null,
  requestedAt: null,
  loading: false,
  error: null,
  data: null,
  people: {},
  confirmedAt: {},
  unsure: {},
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
        people[p.id] = keepLocal ? people[p.id] : { name: p.name, weeklyHours: p.weeklyHours, version: p.version }
      }
      // A row seen at another version than a doubtful save was sent on: that
      // save can no longer land, so the doubt is over.
      const unsure = Object.fromEntries(
        Object.entries(state.unsure).filter(([id, u]) => people[Number(id)]?.version === u.version),
      )
      return {
        ...state,
        loading: false,
        error: null,
        people,
        unsure,
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
      const { id, name, weeklyHours, version } = action.person
      return {
        ...state,
        people: { ...state.people, [id]: { name, weeklyHours, version } },
        confirmedAt: { ...state.confirmedAt, [id]: action.confirmedAt },
        unsure: without(state.unsure, id),
      }
    }

    case 'saveRetrying':
    case 'saveGaveUp': {
      const { id, version, value } = action
      // The row has been seen at another version: this save can no longer land.
      const known = state.people[id]?.version
      if (known !== undefined && known !== version) return state
      const before = state.unsure[id]?.version === version ? state.unsure[id].values : []
      const doubt: Unsure = {
        state: action.type === 'saveRetrying' ? 'retrying' : 'unknown',
        version,
        values: before.includes(value) ? before : [...before, value],
      }
      return { ...state, unsure: { ...state.unsure, [id]: doubt } }
    }
  }
}

function without<T>(record: Record<number, T>, id: number): Record<number, T> {
  const { [id]: _gone, ...rest } = record
  return rest
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
