import type { ISODate } from './dates'

export type CapacityPerson = {
  id: number
  name: string
  /** Capacity for every week. The schema keeps one value per person, no history. */
  weeklyHours: number
  /** Allocated hours, aligned to CapacityResponse.weeks. */
  allocated: number[]
}

export type CapacityResponse = {
  /** The Monday of each week in the range. */
  weeks: ISODate[]
  people: CapacityPerson[]
}

export type Person = { id: number; name: string; weeklyHours: number }

/**
 * A failure with a message that can be shown to a manager as-is.
 *
 * `fromApi` is true only when our API itself answered with its JSON error. Then
 * we know what happened: the request was refused or failed, and nothing was
 * stored. Anything else — no answer, a timeout, a proxy's HTML error page —
 * leaves it unknown whether the server acted on the request.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly fromApi = false,
  ) {
    super(message)
  }
}

/** How long a save waits for an answer. Longer than the API's own 10 s limit
 * (updateTimeout in api/people.go), so a stuck database gives a definite answer. */
export const SAVE_TIMEOUT_MS = 15_000

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(`The server didn't answer within ${SAVE_TIMEOUT_MS / 1000} seconds.`)
    }
    if (init?.signal?.aborted) throw err
    throw new ApiError("Couldn't reach the server. Check your connection and try again.")
  }
  // Error bodies are JSON from our API, but a proxy or a stopped API container
  // answers with plain text or HTML, so a parse failure is not exceptional.
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { error?: unknown } | null)?.error
    if (typeof message === 'string') throw new ApiError(message, true)
    throw new ApiError(`The server couldn't handle the request (${res.status}).`)
  }
  if (body === null) throw new ApiError('The server sent a response we could not read.')
  return body as T
}

export function fetchCapacity(from: ISODate, to: ISODate, signal?: AbortSignal) {
  return request<CapacityResponse>(`/api/capacity?from=${from}&to=${to}`, { signal })
}

export function updateWeeklyHours(id: number, weeklyHours: number) {
  return request<Person>(`/api/people/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weeklyHours }),
    // A save must end, one way or the other, or it would lock editing forever.
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
}
