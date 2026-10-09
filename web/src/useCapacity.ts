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
 * only what *that request* did, so it can't settle the save. Only a 200, or a
 * 412 showing our value, can.
 *  - ok: stored (or found already holding our value);
 *  - changed: the server holds another value now (`changed`, already applied).
 *    `uncertain`: an attempt of this save may have been stored before that.
 *    `earlier`: the value of an earlier, still-doubtful save of this person on
 *    the same version, which may be what the server now holds;
 *  - error, unconfirmed false: this save was refused for certain;
 *  - error, unconfirmed true: no definite answer about this save.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; changed: Person; uncertain: boolean; earlier?: number }
  | { ok: false; error: unknown; unconfirmed: boolean; earlier?: number }

export function useCapacity(from: ISODate, to: ISODate) {
  const [state, dispatch] = useReducer(capacityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Orders loads and saves against each other: see confirmedAt in capacityState.
  const clock = useRef(0)
  const mounted = useRef(true)
  // Read by the save loop, which outlives the render it started in.
  const unsure = useRef(state.unsure)
  unsure.current = state.unsure
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
   * Stores a person's weekly hours. The grid changes only on a definite answer.
   *
   * The save carries the version the grid loaded (If-Match). When an attempt
   * gets no definite answer, the identical request is sent again, up to
   * SAVE_ATTEMPTS times, with "?" shown meanwhile. A repeat either applies
   * (the earlier attempt never landed) or meets a newer version: then the
   * server sends the current row, which is applied as it is fresh. If it holds
   * the value we sent, our earlier attempt landed; if not, the row was changed
   * by someone else and nothing of ours was stored.
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
      const earlier = doubt?.version === version ? doubt.value : undefined
      // Whether an attempt of *this* save has had an unknown outcome.
      let uncertain = false
      for (let attempt = 1; ; attempt++) {
        try {
          confirmWith(await updateWeeklyHours(id, weeklyHours, version))
          return { ok: true }
        } catch (error) {
          if (error instanceof ApiError && error.current) {
            confirmWith(error.current)
            if (error.current.weeklyHours === weeklyHours) return { ok: true }
            return { ok: false, changed: error.current, uncertain, earlier }
          }
          if (isDefiniteFailure(error)) {
            if (!uncertain) return { ok: false, error, unconfirmed: false, earlier }
            // This request stored nothing, but an earlier attempt of the save may have.
            dispatch({ type: 'saveGaveUp', id, version, value: weeklyHours })
            return { ok: false, error, unconfirmed: true }
          }
          uncertain = true
          if (attempt >= SAVE_ATTEMPTS || !mounted.current) {
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
