import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { fetchCapacity, updateWeeklyHours } from './api'
import { capacityReducer, initialState, rangeKey } from './capacityState'
import type { ISODate } from './dates'

export function useCapacity(from: ISODate, to: ISODate) {
  const [state, dispatch] = useReducer(capacityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Orders loads and saves against each other: see confirmedAt in capacityState.
  const clock = useRef(0)

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

  /** Resolves once the server has stored the value; the grid changes only then. */
  const saveWeeklyHours = useCallback(async (id: number, weeklyHours: number) => {
    const person = await updateWeeklyHours(id, weeklyHours)
    dispatch({ type: 'saveConfirmed', person, confirmedAt: ++clock.current })
    return person
  }, [])

  return { state, retry, saveWeeklyHours }
}
