import type { ISODate } from './dates'

export type CapacityPerson = {
  id: number
  name: string
  /** Capacity for every week. The schema keeps one value per person, no history. */
  weeklyHours: number
  /** The row's version (its xmin): sent back as If-Match when saving. */
  version: string
  /** Allocated hours, aligned to CapacityResponse.weeks. */
  allocated: number[]
}

export type CapacityResponse = {
  /** The Monday of each week in the range. */
  weeks: ISODate[]
  people: CapacityPerson[]
}

export type Person = { id: number; name: string; weeklyHours: number; version: string }

/**
 * A failure with a message that can be shown to a manager as-is.
 *
 * `fromApi` is true when our API itself answered with its JSON error.
 * `outcomeUnknown` is true when even the API can't say whether it stored the
 * value (its COMMIT got no answer: `"stored": "unknown"`).
 * `current` comes with a 412: the row changed since the version the save
 * sent, and this is the row as it is now.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly fromApi = false,
    readonly outcomeUnknown = false,
    readonly current?: Person,
  ) {
    super(message)
  }
}

/**
 * True when we know a failed save stored nothing: our API said so. Anything
 * else — no answer, a timeout, a proxy's HTML error page, or the API itself
 * unsure — leaves the server's state unknown.
 */
export function isDefiniteFailure(err: unknown): boolean {
  return err instanceof ApiError && err.fromApi && !err.outcomeUnknown
}

/**
 * How long a save waits for an answer. The chain, so the server always answers
 * first: Postgres gives up on the UPDATE after 10 s (updateTimeout in
 * api/people.go), the API gives up on the whole save after 12 s, the client
 * after 15 s. A timeout here therefore means the answer was lost, not that the
 * server is still deciding.
 */
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
    const { error: message, stored, current } = (body ?? {}) as { error?: unknown; stored?: unknown; current?: Person }
    if (typeof message === 'string') throw new ApiError(message, true, stored === 'unknown', current)
    throw new ApiError(`The server couldn't handle the request (${res.status}).`)
  }
  if (body === null) throw new ApiError('The server sent a response we could not read.')
  return body as T
}

export function fetchCapacity(from: ISODate, to: ISODate, signal?: AbortSignal) {
  return request<CapacityResponse>(`/api/capacity?from=${from}&to=${to}`, { signal })
}

/**
 * Saves only if the row is still at `version` (If-Match). That makes the save
 * safe to repeat when its answer is lost: the identical request either applies
 * (the first attempt never landed) or gets 412 with the current row (it, or
 * someone else, changed the row). And a save made on a stale view can't
 * silently overwrite someone else's change.
 */
export function updateWeeklyHours(id: number, weeklyHours: number, version: string) {
  return request<Person>(`/api/people/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${version}"` },
    body: JSON.stringify({ weeklyHours }),
    // A save must end, one way or the other, or it would lock editing forever.
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
}
