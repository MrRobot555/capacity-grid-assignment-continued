import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { fetchCapacity, isDefiniteFailure, lookupSave, updateWeeklyHours, type Person } from './api'
import { capacityReducer, initialState, rangeKey } from './capacityState'
import type { ISODate } from './dates'

/** While the server says someone's save is in progress, refresh this often. */
const REFRESH_WHILE_SAVING_MS = 2000
/** Between lookups that failed (the server unreachable), wait this long. */
const LOOKUP_RETRY_MS = 2000
const LOOKUP_ATTEMPTS = 30

/**
 * What a save came to. `checking` names a save whose answer was lost: the
 * server is being asked about it, and its outcome will appear in
 * state.outcomes under that id.
 */
export type SaveResult = { ok: true; person: Person } | { ok: false; error: unknown; checking: string | null }

export function useCapacity(from: ISODate, to: ISODate) {
  const [state, dispatch] = useReducer(capacityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Orders loads and saves against each other: see confirmedAt in capacityState.
  const clock = useRef(0)
  // The next load is a background refresh: it shouldn't dim the grid.
  const quiet = useRef(false)
  // Read by the async lookup loop, which outlives the render it started in.
  const instance = useRef(state.instance)
  instance.current = state.instance
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
    dispatch({ type: 'fetchStarted', key, issuedAt, quiet: quiet.current })
    quiet.current = false
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
  const refresh = useCallback(() => {
    quiet.current = true
    setAttempt((n) => n + 1)
  }, [])

  // Someone's save is in progress on the server (another tab, another
  // manager): keep looking until it has settled.
  const anyoneSaving = Object.values(state.people).some((p) => p.saving)
  useEffect(() => {
    if (!anyoneSaving || state.loading) return
    const timer = setTimeout(refresh, REFRESH_WHILE_SAVING_MS)
    return () => clearTimeout(timer)
  }, [anyoneSaving, state.loading, state.requestedAt, refresh])

  /**
   * Asks the server what became of a save whose answer was lost, until it
   * gets a definite answer (or the server says it can't know).
   */
  const resolve = useCallback(async (id: number, saveId: string, sentTo: string | null) => {
    for (let tries = 0; tries < LOOKUP_ATTEMPTS && mounted.current; tries++) {
      try {
        const outcome = await lookupSave(saveId, sentTo)
        if (!mounted.current) return
        // "in-progress": the server already waited a few seconds; ask again.
        if (outcome.state === 'in-progress') continue
        dispatch({ type: 'saveResolved', id, saveId, outcome, at: ++clock.current })
        return
      } catch {
        await new Promise((r) => setTimeout(r, LOOKUP_RETRY_MS))
      }
    }
    if (mounted.current) {
      dispatch({ type: 'saveResolved', id, saveId, outcome: { state: 'unknown' }, at: ++clock.current })
    }
  }, [])

  /**
   * Resolves once the server has stored the value; the grid changes only then.
   * If a save gets no definite answer, the person is marked unsure, the range
   * reloads to show the latest value, and the server is asked what became of
   * that save. Only its answer (or a later confirmed save) removes the doubt.
   */
  const saveWeeklyHours = useCallback(
    async (id: number, weeklyHours: number): Promise<SaveResult> => {
      const saveId = crypto.randomUUID()
      const sentTo = instance.current
      try {
        const person = await updateWeeklyHours(id, weeklyHours, saveId)
        dispatch({ type: 'saveConfirmed', person, confirmedAt: ++clock.current })
        return { ok: true, person }
      } catch (error) {
        if (isDefiniteFailure(error)) return { ok: false, error, checking: null }
        dispatch({ type: 'saveUnconfirmed', id, saveId })
        refresh()
        void resolve(id, saveId, sentTo)
        return { ok: false, error, checking: saveId }
      }
    },
    [refresh, resolve],
  )

  return { state, retry, saveWeeklyHours }
}
