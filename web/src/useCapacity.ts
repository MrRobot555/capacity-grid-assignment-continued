import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ApiError, fetchCapacity, isDefiniteFailure, updateWeeklyHours, type Person } from './api'
import { capacityReducer, initialState, rangeKey } from './capacityState'
import type { ISODate } from './dates'

/** How many times a save is sent before giving up without a definite answer. */
export const SAVE_ATTEMPTS = 5
/** Waits between attempts: 1 s, 2 s, 4 s, 8 s. (An object, so tests can shorten it.) */
export const retryTiming = { delay: (attempt: number) => 1000 * 2 ** (attempt - 1) }

/**
 * What a save came to. An outcome belongs to the save, not to one request:
 * once an attempt's outcome is unknown, a later request's definite answer says
 * only what *that request* did, so it can't settle the save. Only a 200, or
 * the row seen at another version (a 412, or a load), can.
 *  - ok: stored (or the row was seen holding our value);
 *  - changed: the server holds another value now (`changed`, already applied),
 *    known from a 412 or from a load that showed the row at a new version.
 *    `uncertain`: an attempt of this save may have been stored before that.
 *    `earlier`: values of earlier, still-doubtful saves of this person on the
 *    same version, one of which may be what the server now holds;
 *  - error, unconfirmed false: this save was refused for certain;
 *  - error, unconfirmed true: no definite answer about this save.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; changed: Person; uncertain: boolean; earlier?: number[] }
  | { ok: false; error: unknown; unconfirmed: boolean; earlier?: number[] }

export function useCapacity(from: ISODate, to: ISODate) {
  const [state, dispatch] = useReducer(capacityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Orders loads and saves against each other: see confirmedAt in capacityState.
  const clock = useRef(0)
  const mounted = useRef(true)
  // Read by the save loop, which outlives the render it started in.
  const unsure = useRef(state.unsure)
  unsure.current = state.unsure
  const people = useRef(state.people)
  people.current = state.people
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const key = rangeKey(from, to)
    const controller = new AbortController()
    const issuedAt = ++clock.current
    dispatch({ type: 'fetchStarted', key, issuedAt })
    fetchCapacity(from, to, controller.signal).then(
      (response) => dispatch({ type: 'fetchSucceeded', key, issuedAt, response }),
      (err: unknown) => {
        if (controller.signal.aborted) return
        dispatch({ type: 'fetchFailed', key, issuedAt, error: err instanceof Error ? err.message : String(err) })
      },
    )
    // A newer range supersedes this one: stop waiting for it.
    return () => controller.abort()
  }, [from, to, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  /**
   * Stores a person's weekly hours, conditional on the version the editor
   * started from (If-Match). When an attempt gets no definite answer, the
   * identical request is sent again, up to SAVE_ATTEMPTS times, with "?" shown
   * meanwhile.
   *
   * Once an attempt's outcome is unknown, a later request's definite failure
   * says only what *that request* did, so it can't settle the save. What
   * settles it is the row itself, seen at another version: in a 412, or in a
   * load meanwhile. Under If-Match the save can no longer land then, and the
   * row says what the server holds: our value (the save is done) or another.
   */
  const saveWeeklyHours = useCallback(
    async (id: number, weeklyHours: number, version: string): Promise<SaveResult> => {
      // The server's row is fresh, whether a save stored it (200) or the server
      // sent it back (412): one way to apply it, ordered against loads.
      const confirmWith = (person: Person) =>
        dispatch({ type: 'saveConfirmed', person, confirmedAt: ++clock.current })
      // An earlier save of this person, on this same version, whose outcome is
      // unknown: it may be what the server holds by the time we get there.
      const doubt = unsure.current[id]
      const earlier = doubt?.version === version ? doubt.values : undefined
      // Whether an attempt of *this* save has had an unknown outcome.
      let uncertain = false
      // The one reading of a row seen at another version, however it was seen.
      const settledBy = (row: Person): SaveResult =>
        row.weeklyHours === weeklyHours ? { ok: true } : { ok: false, changed: row, uncertain, earlier }
      for (let attempt = 1; ; attempt++) {
        try {
          confirmWith(await updateWeeklyHours(id, weeklyHours, version))
          return { ok: true }
        } catch (error) {
          if (error instanceof ApiError && error.current) {
            confirmWith(error.current)
            return settledBy(error.current)
          }
          const definite = isDefiniteFailure(error)
          if (definite && !uncertain) return { ok: false, error, unconfirmed: false, earlier }
          // From here an attempt of this save may have landed.
          uncertain = true
          const now = people.current[id]
          if (now && now.version !== version) return settledBy({ id, ...now })
          if (definite || attempt >= SAVE_ATTEMPTS || !mounted.current) {
            dispatch({ type: 'saveGaveUp', id, version, value: weeklyHours })
            return { ok: false, error, unconfirmed: true }
          }
          dispatch({ type: 'saveRetrying', id, version, value: weeklyHours })
          await new Promise((r) => setTimeout(r, retryTiming.delay(attempt)))
        }
      }
    },
    [],
  )

  return { state, retry, saveWeeklyHours }
}
