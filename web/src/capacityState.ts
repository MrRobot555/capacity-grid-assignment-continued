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
 *  - 'unknown':  we stopped sending it without a definite answer;
 *  - 'checking': two answers came whose order can't be told, so the server
 *    may hold a newer value; the grid loads the range again (see `place`).
 */
export type Certainty = 'certain' | 'retrying' | 'unknown' | 'checking'

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
  /** The same in a few words, for names and tooltips: "last save not confirmed". */
  doubt: string | null
}

const NOTES: Record<Exclude<Certainty, 'certain'>, string> = {
  retrying: 'The last save got no answer yet. Sending it again until the server answers…',
  unknown:
    "The last save couldn't be confirmed, so the server may hold a different value. Saving again is safe and confirms it.",
  checking: 'Answers arrived out of order, so the server may hold a newer value than shown. Loading the grid again shows it.',
}

const DOUBTS: Record<Exclude<Certainty, 'certain'>, string> = {
  retrying: 'last save not confirmed',
  unknown: 'last save not confirmed',
  checking: 'may not be the latest',
}

export function capacityView(weeklyHours: number, certainty: Certainty): CapacityView {
  const text = `${formatHours(weeklyHours)}h`
  if (certainty === 'certain') return { text, certain: true, note: null, doubt: null }
  return { text, certain: false, note: NOTES[certainty], doubt: DOUBTS[certainty] }
}

export function certaintyOf(state: Pick<State, 'unsure' | 'checking'>, id: number): Certainty {
  return state.unsure[id]?.state ?? (id in state.checking ? 'checking' : 'certain')
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
  /** Each person's row as shown: the newest the grid can prove (see `place`). */
  people: Record<number, Row>
  /** When the shown version first became known: the tick its first answer arrived. */
  knownAt: Record<number, number>
  /** Versions known to come before the shown one. */
  older: Record<number, string[]>
  /** People whose shown row may be older than an answer that couldn't be
   * placed, with the tick that answer arrived; until a later request settles it. */
  checking: Record<number, number>
  /** Counts answers that couldn't be placed: each asks for the range again. */
  recheck: number
  unsure: Record<number, Unsure>
}

type Row = { name: string; weeklyHours: number; version: string }

export type Action =
  | { type: 'fetchStarted'; key: string; issuedAt: number }
  | { type: 'fetchSucceeded'; key: string; issuedAt: number; receivedAt: number; response: CapacityResponse }
  | { type: 'fetchFailed'; key: string; issuedAt: number; error: string }
  /** The server's row in answer to a save sent on `sentOn` (If-Match): what
   * it stored (200), or what it holds (412). Placed like any answer. */
  | { type: 'saveAnswered'; person: Person; stored: boolean; sentOn: string; sentAt: number; receivedAt: number }
  | { type: 'saveRetrying'; id: number; version: string; value: number }
  | { type: 'saveGaveUp'; id: number; version: string; value: number }

export const initialState: State = {
  requestedKey: null,
  requestedAt: null,
  loading: false,
  error: null,
  data: null,
  people: {},
  knownAt: {},
  older: {},
  checking: {},
  recheck: 0,
  unsure: {},
}

// The database orders by name, but the Postgres image runs on musl, whose
// collation is byte order: "Öztürk" sorts after "Yilmaz". Order for people.
const byName = new Intl.Collator(undefined, { sensitivity: 'base' })

export function rangeKey(from: ISODate, to: ISODate): string {
  return `${from}..${to}`
}

/**
 * An answer carrying a person's row: sent at `sentAt`, arrived at `receivedAt`
 * (one clock for loads and saves), so the server read the row in between.
 * `over`: for a stored save, the version it was written over (If-Match), which
 * ours directly follows.
 */
type Answer = { row: Row; sentAt: number; receivedAt: number; over?: string }

/**
 * Where an answer's row stands against the row shown. The server's history is
 * one line, so:
 *  - newer, when it was sent after the shown version first became known: the
 *    server already held that version, and read later. (This covers our save
 *    written over the shown version: it was sent on a version already known.)
 *    Time decides first, because it holds even when versions repeat, as `xmin`
 *    does after the database is re-created or restored;
 *  - older, when its version is one known to come before the shown one, or it
 *    is our save written over such a version (then the shown row came after
 *    ours: it is neither ours nor the one ours followed);
 *  - unknown otherwise, including the shown version carrying other data (a
 *    repeat). Nothing else can tell, so the row shown stays, marked, and the
 *    range is loaded again: a load sent now is newer than both.
 */
function place(state: State, id: number, a: Answer): 'new' | 'same' | 'newer' | 'older' | 'unknown' {
  const shown = state.people[id]
  if (shown === undefined) return 'new'
  if (a.row.version === shown.version && a.row.weeklyHours === shown.weeklyHours && a.row.name === shown.name) return 'same'
  if (a.sentAt > state.knownAt[id]) return 'newer'
  if (a.row.version === shown.version) return 'unknown'
  const older = state.older[id] ?? []
  if (older.includes(a.row.version)) return 'older'
  if (a.over !== undefined && older.includes(a.over)) return 'older'
  return 'unknown'
}

/** The state after one answer about one person. */
function answered(state: State, id: number, a: Answer): State {
  const where = place(state, id, a)
  // An answer sent after the unplaceable one arrived read the server after it:
  // its row is at or after that one. Placed against the row shown (newer, the
  // same, or older, which puts the row shown after it too), it settles which
  // is the newest.
  const settles = where !== 'unknown' && a.sentAt > (state.checking[id] ?? Infinity)
  const checking = settles ? without(state.checking, id) : state.checking
  if (where === 'same' || where === 'older') return { ...state, checking }
  if (where === 'unknown') {
    return { ...state, checking: { ...state.checking, [id]: a.receivedAt }, recheck: state.recheck + 1 }
  }
  const shown = state.people[id]
  // A newer row at a version already seen: versions repeated (the database was
  // re-created), so what was known to be older no longer says anything.
  const repeated = shown !== undefined && (a.row.version === shown.version || (state.older[id] ?? []).includes(a.row.version))
  // (A stored save's `over` is the row shown or already among the older: it
  // was the row shown when the save was sent.)
  const before = repeated ? [] : [...(state.older[id] ?? []), ...(shown ? [shown.version] : [])]
  return {
    ...state,
    checking,
    people: { ...state.people, [id]: a.row },
    knownAt: { ...state.knownAt, [id]: a.receivedAt },
    older: { ...state.older, [id]: [...new Set(before)] },
  }
}

export function capacityReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'fetchStarted':
      return { ...state, requestedKey: action.key, requestedAt: action.issuedAt, loading: true, error: null }

    case 'fetchSucceeded': {
      // Matching the request, not just the range: after A → B → A, the first
      // request for A is as stale as the one for B.
      if (action.issuedAt !== state.requestedAt) return state
      let next = state
      for (const p of action.response.people) {
        const row = { name: p.name, weeklyHours: p.weeklyHours, version: p.version }
        next = answered(next, p.id, { row, sentAt: action.issuedAt, receivedAt: action.receivedAt })
      }
      // A row seen at another version than a doubtful save was sent on: that
      // save can no longer land, so the doubt is over.
      const unsure = Object.fromEntries(
        Object.entries(next.unsure).filter(([id, u]) => next.people[Number(id)]?.version === u.version),
      )
      return {
        ...next,
        loading: false,
        error: null,
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

    case 'saveAnswered': {
      const { id, name, weeklyHours, version } = action.person
      const next = answered(state, id, {
        row: { name, weeklyHours, version },
        sentAt: action.sentAt,
        receivedAt: action.receivedAt,
        over: action.stored ? action.sentOn : undefined,
      })
      // Either answer says the server is past the version the save was sent
      // on (it wrote over it, or holds another): no save on it can land now.
      return next.unsure[id]?.version === action.sentOn ? { ...next, unsure: without(next.unsure, id) } : next
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
