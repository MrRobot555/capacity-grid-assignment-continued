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
 *  - 'certain':  the last value the server confirmed (or loaded after it);
 *  - 'retrying': a save of ours got no definite answer and is being sent
 *    again, or was just confirmed by a repeat and the range is reloading;
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
  const unsure = state.unsure[id]
  if (!unsure) return 'certain'
  return unsure.state === 'unknown' ? 'unknown' : 'retrying'
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
 * Doubt about one person's capacity.
 *  - 'retrying': our save is being sent again;
 *  - 'settled': a repeat got a definite answer, so the save is finished, and
 *    a load issued after `at` shows the truth;
 *  - 'unknown': we gave up without a definite answer. Only a confirmed save
 *    clears it: a load can't, because a lost save may still be on its way.
 */
type Unsure = { state: 'retrying' } | { state: 'settled'; at: number } | { state: 'unknown' }

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
  unsure: Record<number, Unsure>
}

export type Action =
  | { type: 'fetchStarted'; key: string; issuedAt: number }
  | { type: 'fetchSucceeded'; key: string; issuedAt: number; response: CapacityResponse }
  | { type: 'fetchFailed'; key: string; issuedAt: number; error: string }
  /** A save answered at the first attempt: its payload is the stored row. */
  | { type: 'saveConfirmed'; person: Person; confirmedAt: number }
  | { type: 'saveRetrying'; id: number }
  /** A repeat got a definite answer. Its payload may be an old record, so it is
   * not applied: the range reloads, and the load shows what the server holds. */
  | { type: 'saveSettled'; id: number; at: number }
  | { type: 'saveGaveUp'; id: number }

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
        people[p.id] = { name: p.name, weeklyHours: keepLocal ? people[p.id].weeklyHours : p.weeklyHours }
      }
      // A load issued after a save was settled shows that save's outcome.
      const unsure = Object.fromEntries(
        Object.entries(state.unsure).filter(([, u]) => !(u.state === 'settled' && u.at < action.issuedAt)),
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
      const { id, name, weeklyHours } = action.person
      return {
        ...state,
        people: { ...state.people, [id]: { name, weeklyHours } },
        confirmedAt: { ...state.confirmedAt, [id]: action.confirmedAt },
        unsure: without(state.unsure, id),
      }
    }

    case 'saveRetrying':
      return { ...state, unsure: { ...state.unsure, [action.id]: { state: 'retrying' } } }

    case 'saveSettled':
      return { ...state, unsure: { ...state.unsure, [action.id]: { state: 'settled', at: action.at } } }

    case 'saveGaveUp':
      return { ...state, unsure: { ...state.unsure, [action.id]: { state: 'unknown' } } }
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
