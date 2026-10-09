import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ApiError, fetchCapacity, isDefiniteFailure, updateWeeklyHours, type Person } from './api'
import { capacityReducer, initialState, rangeKey } from './capacityState'
import type { ISODate } from './dates'

/** How many times a save is sent before giving up without a definite answer. */
export const SAVE_ATTEMPTS = 5
/** Waits between attempts: 1 s, 2 s, 4 s, 8 s. (An object, so tests can shorten it.) */
export const retryTiming = { delay: (attempt: number) => 1000 * 2 ** (attempt - 1) }

/**
 * What a save came to:
 *  - ok: stored (or, after a lost answer, found already stored);
 *  - changed: the row changed on the server since it was loaded; nothing of
 *    ours stored. `current` is the row now (already applied to the grid);
 *  - definite: refused for certain, nothing stored;
 *  - unconfirmed: no definite answer after SAVE_ATTEMPTS tries.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; changed: Person }
  | { ok: false; error: unknown; unconfirmed: boolean }

export function useCapacity(from: ISODate, to: ISODate) {
  const [state, dispatch] = useReducer(capacityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Orders loads and saves against each other: see confirmedAt in capacityState.
  const clock = useRef(0)
  const mounted = useRef(true)
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
      for (let attempt = 1; ; attempt++) {
        try {
          const person = await updateWeeklyHours(id, weeklyHours, version)
          dispatch({ type: 'saveConfirmed', person, confirmedAt: ++clock.current })
          return { ok: true }
        } catch (error) {
          if (error instanceof ApiError && error.current) {
            dispatch({ type: 'saveConfirmed', person: error.current, confirmedAt: ++clock.current })
            return error.current.weeklyHours === weeklyHours ? { ok: true } : { ok: false, changed: error.current }
          }
          if (isDefiniteFailure(error)) return { ok: false, error, unconfirmed: false }
          if (attempt >= SAVE_ATTEMPTS || !mounted.current) {
            dispatch({ type: 'saveGaveUp', id })
            return { ok: false, error, unconfirmed: true }
          }
          dispatch({ type: 'saveRetrying', id })
          await new Promise((r) => setTimeout(r, retryTiming.delay(attempt)))
        }
      }
    },
    [],
  )

  return { state, retry, saveWeeklyHours }
}
