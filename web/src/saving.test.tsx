import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapacityGrid } from './CapacityGrid'
import { retryTiming, SAVE_ATTEMPTS } from './useCapacity'

// What the manager is told after a save, what the grid shows, and where focus
// goes. "Not saved" only when the server said nothing was stored. When an
// answer is lost, the identical request (same Save-Id) is sent again until a
// definite answer; a definite answer to a repeat is never applied as the new
// value (it may be old): the range reloads instead.
//
// A fake server with state, modelling the API's repeat handling
// (api/saves.go): a repeat of a stored save is answered from the record, of a
// refused one is refused, of one with an unknown outcome runs again.

type Outcome =
  | 'store' // store it and answer 200
  | 'store-and-lose-answer' // store it, then the connection drops
  | 'lose-request' // the request never reaches the API
  | 'refuse' // our API's JSON 500: nothing stored
  | 'commit-unknown' // stored, but the API couldn't tell (its COMMIT got no answer)
  | 'html-500' // a proxy's error page after the API stored it
  | 'timeout' // stored, but the client gave up waiting
  | 'no-answer' // the client gave up waiting, and nothing was stored
  | 'hold' // stores and answers only when released

type Row = { id: number; name: string; weeklyHours: number }
type SaveRecord = { state: 'stored' | 'refused' | 'unknown'; person?: Row; id: number; value: number }

function fakeServer(outcomes: Outcome[]) {
  const hours: Record<number, number> = { 1: 40, 4: 40 }
  const names: Record<number, string> = { 1: 'Ana Ferreira', 4: 'Dee Okafor' }
  const allocated: Record<number, number[]> = { 1: [0, 30], 4: [45, 40] }
  const records = new Map<string, SaveRecord>()
  let release: (() => void) | null = null
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const person = (id: number): Row => ({ id, name: names[id], weeklyHours: hours[id] })

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') {
      return json(200, {
        weeks: ['2026-01-05', '2026-01-12'],
        people: [1, 4].map((id) => ({ ...person(id), allocated: allocated[id] })),
      })
    }
    const id = Number(url.split('/').pop())
    const saveId = new Headers(init.headers).get('Save-Id')!
    const value = JSON.parse(String(init.body)).weeklyHours as number
    const prev = records.get(saveId)
    if (prev?.state === 'stored') return json(200, prev.person) // a repeat, answered from the record
    if (prev?.state === 'refused') return json(409, { error: 'this save was already refused and was not stored' })
    const store = () => {
      hours[id] = value
      records.set(saveId, { state: 'stored', person: person(id), id, value })
    }
    const outcome = outcomes.shift() ?? 'store'
    switch (outcome) {
      case 'store':
        store()
        return json(200, person(id))
      case 'store-and-lose-answer':
        store()
        throw new TypeError('Failed to fetch')
      case 'lose-request':
        throw new TypeError('Failed to fetch')
      case 'refuse':
        records.set(saveId, { state: 'refused', id, value })
        return json(500, { error: 'could not update person' })
      case 'commit-unknown':
        hours[id] = value
        records.set(saveId, { state: 'unknown', id, value })
        return json(500, { error: "the save couldn't be confirmed", stored: 'unknown' })
      case 'html-500':
        store()
        return new Response('<html>Internal Server Error</html>', { status: 500 })
      case 'timeout':
        store()
        throw new DOMException('signal timed out', 'TimeoutError')
      case 'no-answer':
        throw new DOMException('signal timed out', 'TimeoutError')
      case 'hold':
        await new Promise<void>((resolve) => (release = resolve))
        store()
        return json(200, person(id))
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    hours,
    patches: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    saveIds: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => new Headers(init?.headers).get('Save-Id')),
    release: () => release?.(),
  }
}

// Scoped to the row header: the editor panel's title repeats the name.
const row = (name: string) => screen.getByText(name, { selector: 'th' }).closest('tr')!
const capButton = (name: string) =>
  within(row(name)).getByRole('button', { name: new RegExp(`Weekly hours for ${name}`) })

async function edit(name: string, value: string) {
  await screen.findByText(name, { selector: 'th' })
  if (!screen.queryByLabelText(`Weekly hours for ${name}`)) fireEvent.click(capButton(name))
  const input = screen.getByLabelText(`Weekly hours for ${name}`)
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(input.closest('form')!)
}

function renderGrid() {
  return render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
}

const realDelay = retryTiming.delay
beforeEach(() => {
  retryTiming.delay = () => 5
})
afterEach(() => {
  retryTiming.delay = realDelay
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what a failed save says', () => {
  it('says "Not saved" when our API refused it, and does not send it again', async () => {
    const server = fakeServer(['refuse'])
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. could not update person')
    expect(server.patches()).toHaveLength(1)
  })

  it.each([
    ['the answer is lost', 'store-and-lose-answer' as Outcome],
    ['the request never arrives', 'lose-request' as Outcome],
    ["a proxy's HTML page answers, even with a 500", 'html-500' as Outcome],
    ['the save times out', 'timeout' as Outcome],
    ['our API itself cannot tell (lost COMMIT)', 'commit-unknown' as Outcome],
  ])('sends the same save again when %s, and never says "Not saved"', async (_, outcome) => {
    const server = fakeServer([outcome])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument()
    const ids = server.saveIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0]) // the identical request, so the API can recognise the repeat
    expect(server.hours[4]).toBe(50)
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/))
  })

  it(`gives up after ${SAVE_ATTEMPTS} attempts without a definite answer, and says so`, async () => {
    const server = fakeServer(Array(SAVE_ATTEMPTS).fill('no-answer'))
    renderGrid()
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`Couldn't confirm the save after ${SAVE_ATTEMPTS} tries`)
    expect(alert).toHaveTextContent("didn't answer within 15 seconds")
    expect(alert).not.toHaveTextContent('Not saved')
    expect(server.patches()).toHaveLength(SAVE_ATTEMPTS)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('gives each attempt 15 seconds, longer than the API gives it (12 s)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000))
  })

  it('names every new save differently', async () => {
    const server = fakeServer(['refuse', 'store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(server.patches()).toHaveLength(2))
    const [first, second] = server.saveIds()
    expect(first).toBeTruthy()
    expect(second).not.toBe(first)
  })

  // Served over plain HTTP on a network address (not localhost), the page is
  // not a secure context and crypto.randomUUID doesn't exist.
  it('saves without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const server = fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(server.hours[4]).toBe(50))
  })

  it('ends the save with a message if something throws before it is sent', async () => {
    fakeServer([])
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('no randomness here')
      },
    })
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong before the save was sent')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('while a save is being sent again', () => {
  it('shows "?" and says why, and keeps every editor closed to new saves', async () => {
    // The first attempt never arrives, so the repeat runs (and is held).
    const server = fakeServer(['lose-request', 'hold'])
    renderGrid()
    await edit('Dee Okafor', '50')

    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent('40h ?'))
    expect(capButton('Dee Okafor')).toHaveAccessibleName(/last save not confirmed/)
    expect(capButton('Dee Okafor')).toHaveAttribute('title', expect.stringMatching(/Sending it again/))
    const deeCell = within(row('Dee Okafor')).getAllByRole('cell')[1]
    expect(deeCell).toHaveAttribute('title', expect.stringContaining('(capacity not confirmed)'))
    expect(screen.getByText(/people over capacity/)).toHaveTextContent('(1 with a capacity not yet confirmed, marked ?)')
    expect(screen.getByText('Changes capacity for every week, past and future.')).toBeInTheDocument()
    expect(screen.getByText(/Sending it again/, { selector: '.cap-editor p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true')
    expect(capButton('Ana Ferreira')).toBeDisabled()

    await act(async () => server.release())
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/))
  })

  // The answer to a repeat can be the API's record of an earlier attempt,
  // older than a change someone made since. Applying it would show a stale
  // value as confirmed; the reload shows what the server holds.
  it('never applies a repeat answer as the new value', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    const original = vi.mocked(fetch).getMockImplementation()!
    let patches = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH' && ++patches === 2) server.hours[4] = 30 // another manager, before the repeat
      return original(url, init)
    })
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^30h$/))
  })
})

describe('after giving up', () => {
  it('keeps "?" until a save of that person is confirmed, and a repeat of the old value reaches the server', async () => {
    const server = fakeServer([...Array(SAVE_ATTEMPTS).fill('lose-request'), 'store', 'store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByText(/Couldn't confirm the save after/)
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')
    expect(capButton('Dee Okafor')).toHaveAttribute('title', expect.stringMatching(/may hold a different value/))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // A confirmed save of someone else doesn't settle Dee.
    await edit('Ana Ferreira', '36')
    await waitFor(() => expect(capButton('Ana Ferreira')).toHaveTextContent(/^36h$/))
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')

    // Going back to 40 must reach the server instead of looking "unchanged".
    await edit('Dee Okafor', '40')
    await waitFor(() => expect(server.patches()).toHaveLength(SAVE_ATTEMPTS + 2))
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^40h$/))
  })
})

describe('the editor', () => {
  it('sends nothing when the value is unchanged', async () => {
    const server = fakeServer([])
    renderGrid()
    await edit('Dee Okafor', '40')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(server.patches()).toHaveLength(0)
  })

  it('cannot be cancelled, edited, escaped or submitted again while a save is in flight', async () => {
    const server = fakeServer(['hold'])
    renderGrid()
    await edit('Dee Okafor', '50')
    const saving = await screen.findByRole('button', { name: 'Saving…' })

    const input = screen.getByLabelText('Weekly hours for Dee Okafor')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(saving).toHaveAttribute('aria-disabled', 'true')
    expect(input).toHaveAttribute('readonly')
    expect(capButton('Ana Ferreira')).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toBeInTheDocument()
    fireEvent.click(saving)
    expect(server.patches()).toHaveLength(1)

    await act(async () => server.release())
  })

  it("disables the person's own capacity button while their editor is open", async () => {
    fakeServer([])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    fireEvent.click(capButton('Dee Okafor'))
    expect(capButton('Dee Okafor')).toBeDisabled()
  })

  it('finishes a save whose row was filtered out meanwhile', async () => {
    const server = fakeServer(['hold'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })
    fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'ana' } })
    expect(screen.queryByText('Dee Okafor', { selector: 'th' })).not.toBeInTheDocument()
    await act(async () => server.release())
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
  })

  it('shows a failure even when the row is filtered out', async () => {
    fakeServer(['refuse'])
    renderGrid()
    fireEvent.click(await screen.findByLabelText('Only over capacity'))
    await edit('Dee Okafor', '50') // Dee is over, so visible
    fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'ana' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved.')
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toHaveValue(50)
  })

  it('survives a range change while a save is in flight, and shows its failure', async () => {
    let failSave!: () => void
    const server = fakeServer([])
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((resolve) => {
            failSave = () =>
              resolve(new Response(JSON.stringify({ error: 'could not update person' }), { status: 500 }))
          })
        : original(url, init),
    )
    const { rerender } = renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })
    rerender(<CapacityGrid from="2026-01-12" to="2026-01-25" onRangeChange={() => {}} />)
    await act(async () => failSave())
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. could not update person')
    expect(server.patches()).toHaveLength(1)
  })

  it("doesn't take focus when rows are filtered out and back in", async () => {
    fakeServer([])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    fireEvent.click(capButton('Dee Okafor'))
    const search = screen.getByLabelText('Find person')
    search.focus()
    fireEvent.change(search, { target: { value: 'ana' } })
    fireEvent.change(search, { target: { value: '' } })
    expect(search).toHaveFocus()
  })
})

describe('focus when the editor closes', () => {
  it('returns to the capacity button after Escape', async () => {
    fakeServer([])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    fireEvent.click(capButton('Dee Okafor'))
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveFocus())
  })

  it('returns to the capacity button after a save made from the editor', async () => {
    fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveFocus())
  })

  it('stays where the manager put it if they moved on during a slow save', async () => {
    const server = fakeServer(['hold'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })
    const search = screen.getByLabelText('Find person')
    search.focus()
    await act(async () => server.release())
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(search).toHaveFocus()
  })

  it('stays where the manager put it if they moved on and the save then failed', async () => {
    let failSave!: () => void
    fakeServer([])
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((resolve) => {
            failSave = () =>
              resolve(new Response(JSON.stringify({ error: 'could not update person' }), { status: 500 }))
          })
        : original(url, init),
    )
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })
    const search = screen.getByLabelText('Find person')
    search.focus()
    await act(async () => failSave())
    await screen.findByRole('alert')
    expect(search).toHaveFocus()
  })

  it('goes to the grid when the saved row has left the filtered list', async () => {
    fakeServer(['store'])
    renderGrid()
    fireEvent.click(await screen.findByLabelText('Only over capacity'))
    await edit('Dee Okafor', '50') // 45 of 50 is no longer over: her row leaves the list
    await waitFor(() => expect(screen.getByRole('region', { name: 'Capacity by person and week' })).toHaveFocus())
  })
})
