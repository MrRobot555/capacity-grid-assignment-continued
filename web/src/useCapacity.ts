import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { fetchCapacity, isDefiniteFailure, newSaveId, updateWeeklyHours } from './api'
import { capacityReducer, initialState, rangeKey } from './capacityState'
import type { ISODate } from './dates'

/** How many times a save is sent before giving up without a definite answer. */
export const SAVE_ATTEMPTS = 5
/** Waits between attempts: 1 s, 2 s, 4 s, 8 s. (An object, so tests can shorten it.) */
export const retryTiming = { delay: (attempt: number) => 1000 * 2 ** (attempt - 1) }

/**
 * What a save came to:
 *  - ok: stored;
 *  - definite: refused for certain, nothing stored;
 *  - unconfirmed: no definite answer after SAVE_ATTEMPTS tries.
 */
export type SaveResult = { ok: true } | { ok: false; error: unknown; unconfirmed: boolean }

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
   * A save sets an absolute value, so sending it again is safe: when an
   * attempt gets no definite answer, the identical request (same Save-Id) is
   * sent again, up to SAVE_ATTEMPTS times. The person shows "?" meanwhile.
   * A definite answer to a repeat isn't applied as the new value: it may be
   * the API's record of an earlier attempt, older than a change made since.
   * The range reloads instead, and the load shows what the server holds.
   */
  const saveWeeklyHours = useCallback(
    async (id: number, weeklyHours: number): Promise<SaveResult> => {
      const saveId = newSaveId()
      for (let attempt = 1; ; attempt++) {
        try {
          const person = await updateWeeklyHours(id, weeklyHours, saveId)
          if (attempt === 1) {
            dispatch({ type: 'saveConfirmed', person, confirmedAt: ++clock.current })
          } else {
            dispatch({ type: 'saveSettled', id, at: ++clock.current })
            retry()
          }
          return { ok: true }
        } catch (error) {
          if (isDefiniteFailure(error)) {
            if (attempt > 1) {
              // Nothing stored by this save; reload so "?" goes with the truth.
              dispatch({ type: 'saveSettled', id, at: ++clock.current })
              retry()
            }
            return { ok: false, error, unconfirmed: false }
          }
          if (attempt >= SAVE_ATTEMPTS || !mounted.current) {
            dispatch({ type: 'saveGaveUp', id })
            return { ok: false, error, unconfirmed: true }
          }
          dispatch({ type: 'saveRetrying', id })
          await new Promise((r) => setTimeout(r, retryTiming.delay(attempt)))
        }
      }
    },
    [retry],
  )

  return { state, retry, saveWeeklyHours }
}
