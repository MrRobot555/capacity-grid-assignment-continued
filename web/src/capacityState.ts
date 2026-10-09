import type { CapacityResponse, Person, SaveOutcome } from './api'
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
 *  - 'certain': the last value the server confirmed;
 *  - 'checking': a save of ours got no answer, and we are asking the server
 *    what became of it (lookupSave);
 *  - 'unknown': the server can't tell (it restarted meanwhile, or lost touch
 *    with the database at the moment of COMMIT);
 *  - 'saving': the server says a save for this person is in progress,
 *    whoever sent it (another tab, another manager).
 */
export type Certainty = 'certain' | 'checking' | 'unknown' | 'saving'

/**
 * How to show a person's capacity, and how sure we are about it. Every place
 * that shows a person's capacity uses this (button, its accessible name, its
 * tooltip, cell tooltips, the editor's title and hint), so none of them can
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
  checking: 'The last save got no answer. Checking with the server whether it went through…',
  unknown:
    "The last save couldn't be confirmed (the server can't tell whether it went through), so it may hold a different value. Saving again is safe and confirms it.",
  saving: 'A save for this person is in progress on the server, so this value may be about to change.',
}

export function capacityView(weeklyHours: number, certainty: Certainty): CapacityView {
  const text = `${formatHours(weeklyHours)}h`
  if (certainty === 'certain') return { text, certain: true, note: null }
  return { text, certain: false, note: NOTES[certainty] }
}

/** The certainty of one person's capacity, from what the state knows. */
export function certaintyOf(state: Pick<State, 'unsure' | 'people'>, id: number): Certainty {
  const unsure = state.unsure[id]
  if (unsure) return unsure.checking ? 'checking' : 'unknown'
  return state.people[id]?.saving ? 'saving' : 'certain'
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

export type State = {
  /** The range the grid is asking for. */
  requestedKey: string | null
  /** The request it is waiting for. Responses to any other request are dropped. */
  requestedAt: number | null
  loading: boolean
  error: string | null
  /** The last range that loaded. Kept on screen while the next one loads or fails. */
  data: Loaded | null
  /** `saving`: the server says a save for this person is in progress. */
  people: Record<number, { name: string; weeklyHours: number; saving: boolean }>
  /** When each person's latest save was confirmed, on the same clock as `issuedAt`. */
  confirmedAt: Record<number, number>
  /**
   * People whose last save got no definite answer: which save, and whether we
   * are still asking the server about it. A load never clears this (a proxy
   * can give up while the API is still saving, so a load can read the old
   * value just before the save commits). Only the server's answer about that
   * save does, or a later save of the person that is confirmed.
   */
  unsure: Record<number, { saveId: string; checking: boolean }>
  /** The API process that answered the last load (to look saves up with). */
  instance: string | null
  /** What the server said about saves whose answer was lost, by save id. */
  outcomes: Record<string, 'stored' | 'not-stored' | 'unknown'>
}

export type Action =
  /** `quiet`: a background refresh, which doesn't dim the grid. */
  | { type: 'fetchStarted'; key: string; issuedAt: number; quiet?: boolean }
  | { type: 'fetchSucceeded'; key: string; issuedAt: number; response: CapacityResponse }
  | { type: 'fetchFailed'; key: string; issuedAt: number; error: string }
  | { type: 'saveConfirmed'; person: Person; confirmedAt: number }
  | { type: 'saveUnconfirmed'; id: number; saveId: string }
  /** The server's answer about a save whose own answer was lost. */
  | { type: 'saveResolved'; id: number; saveId: string; outcome: SaveOutcome; at: number }

export const initialState: State = {
  requestedKey: null,
  requestedAt: null,
  loading: false,
  error: null,
  data: null,
  people: {},
  confirmedAt: {},
  unsure: {},
  instance: null,
  outcomes: {},
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
      return {
        ...state,
        requestedKey: action.key,
        requestedAt: action.issuedAt,
        loading: action.quiet ? state.loading : true,
        error: action.quiet ? state.error : null,
      }

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
        people[p.id] = {
          name: p.name,
          weeklyHours: keepLocal ? people[p.id].weeklyHours : p.weeklyHours,
          saving: p.saving === true,
        }
      }
      return {
        ...state,
        loading: false,
        error: null,
        people,
        instance: action.response.instance ?? state.instance,
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

    case 'saveConfirmed':
      return confirm(state, action.person, action.confirmedAt)

    case 'saveUnconfirmed':
      return { ...state, unsure: { ...state.unsure, [action.id]: { saveId: action.saveId, checking: true } } }

    case 'saveResolved': {
      const { outcome } = action
      if (outcome.state === 'in-progress') return state
      state = { ...state, outcomes: { ...state.outcomes, [action.saveId]: outcome.state } }
      // Only the save the person is unsure about; a later one may have settled it.
      if (state.unsure[action.id]?.saveId !== action.saveId) return state
      if (outcome.state === 'stored') return confirm(state, outcome.person, action.at)
      if (outcome.state === 'not-stored') return { ...state, unsure: without(state.unsure, action.id) }
      if (outcome.state === 'unknown') {
        return { ...state, unsure: { ...state.unsure, [action.id]: { saveId: action.saveId, checking: false } } }
      }
      return state
    }
  }
}

function confirm(state: State, person: Person, at: number): State {
  const { id, name, weeklyHours } = person
  return {
    ...state,
    people: { ...state.people, [id]: { name, weeklyHours, saving: state.people[id]?.saving ?? false } },
    confirmedAt: { ...state.confirmedAt, [id]: at },
    unsure: without(state.unsure, id),
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
