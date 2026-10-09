import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacityGrid } from './CapacityGrid'

// What the manager is told after a save, what the grid shows, and where focus
// goes. The rule: "Not saved" only when the server said nothing was stored.
// When an answer is lost, the grid asks the server what became of that save
// (its Save-Id) and shows "?" until the server answers.
//
// A fake server with state, modelling the API's save-outcome registry
// (api/saves.go): outcomes recorded by Save-Id, unseen ids fenced on lookup,
// "unknown" for saves sent to an earlier process.

type Outcome =
  | 'store' // store it and answer 200
  | 'store-and-lose-answer' // store it, then the connection drops
  | 'lose-request' // the request never reaches the API
  | 'refuse' // our API's JSON 500: nothing stored
  | 'commit-unknown' // stored, but the API couldn't tell (lost contact with Postgres)
  | 'html-500' // a proxy's error page after the API stored it
  | 'timeout' // stored, but the client gave up waiting
  | 'hold' // answers only when released

type SaveRecord = { state: 'stored' | 'not-stored' | 'unknown'; person?: { id: number; name: string; weeklyHours: number } }

function fakeServer(outcomes: Outcome[], options: { saving?: number[] } = {}) {
  const hours: Record<number, number> = { 1: 40, 4: 40 }
  const names: Record<number, string> = { 1: 'Ana Ferreira', 4: 'Dee Okafor' }
  const allocated: Record<number, number[]> = { 1: [0, 30], 4: [45, 40] }
  let instance = 'process-1'
  let records = new Map<string, SaveRecord>()
  let saving = new Set(options.saving ?? [])
  let failLoads = false
  let failLookups = false
  let release: (() => void) | null = null
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Server-Instance': instance },
    })
  const person = (id: number) => ({ id, name: names[id], weeklyHours: hours[id] })

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0]
    if (path.startsWith('/api/saves/')) {
      if (failLookups) return new Response('<html>Bad Gateway</html>', { status: 502 })
      const id = decodeURIComponent(path.split('/').pop()!)
      const asked = new URLSearchParams(url.split('?')[1]).get('instance')
      const rec = records.get(id)
      if (rec) return json(200, rec)
      if (asked !== instance) return json(200, { state: 'unknown' })
      records.set(id, { state: 'not-stored' }) // fenced
      return json(200, { state: 'not-stored' })
    }
    if (init?.method !== 'PATCH') {
      if (failLoads) return new Response('<html>Bad Gateway</html>', { status: 502 })
      return json(200, {
        weeks: ['2026-01-05', '2026-01-12'],
        people: [1, 4].map((id) => ({ ...person(id), allocated: allocated[id], saving: saving.has(id) || undefined })),
      })
    }
    const id = Number(path.split('/').pop())
    const saveId = new Headers(init.headers).get('Save-Id')!
    const value = JSON.parse(String(init.body)).weeklyHours as number
    if (records.has(saveId)) return json(409, { error: 'this save was given up on and was not stored' })
    const store = () => {
      hours[id] = value
      records.set(saveId, { state: 'stored', person: person(id) })
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
        records.set(saveId, { state: 'not-stored' })
        return json(500, { error: 'could not update person' })
      case 'commit-unknown':
        hours[id] = value
        records.set(saveId, { state: 'unknown' })
        return json(500, { error: "the save couldn't be confirmed", stored: 'unknown' })
      case 'html-500':
        store()
        return new Response('<html>Internal Server Error</html>', { status: 500 })
      case 'timeout':
        store()
        throw new DOMException('signal timed out', 'TimeoutError')
      case 'hold':
        await new Promise<void>((resolve) => (release = resolve))
        store()
        return json(200, person(id))
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const calls = (pred: (url: string, init?: RequestInit) => boolean) =>
    fetchMock.mock.calls.filter(([url, init]) => pred(url, init))
  return {
    hours,
    patches: () => calls((_, init) => init?.method === 'PATCH'),
    lookups: () => calls((url) => url.startsWith('/api/saves/')).length,
    failLoads: (fail: boolean) => (failLoads = fail),
    failLookups: (fail: boolean) => (failLookups = fail),
    restart: () => {
      instance = 'process-2'
      records = new Map()
    },
    stopSaving: () => (saving = new Set()),
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what a failed save says', () => {
  it('says "Not saved" when our API refused it, without asking again', async () => {
    const server = fakeServer(['refuse'])
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. could not update person')
    expect(server.lookups()).toBe(0)
  })

  it.each([
    ['the answer is lost', 'store-and-lose-answer' as Outcome],
    ["a proxy's HTML page answers, even with a 500", 'html-500' as Outcome],
    ['the save times out', 'timeout' as Outcome],
    ['our API itself cannot tell (lost COMMIT)', 'commit-unknown' as Outcome],
  ])('never says "Not saved" when %s', async (_, outcome) => {
    const server = fakeServer([outcome])
    server.failLookups(true) // keep it at the first answer
    renderGrid()
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't confirm the save yet")
    expect(alert).not.toHaveTextContent('Not saved')
  })

  it('names the timeout, and lets the manager cancel', async () => {
    const server = fakeServer(['timeout'])
    server.failLookups(true)
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent("didn't answer within 15 seconds")
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('gives a save 15 seconds, longer than the API gives it (12 s)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000))
  })

  it('names every save, with a new name for every attempt', async () => {
    const server = fakeServer(['refuse', 'store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(server.patches()).toHaveLength(2))
    const ids = server.patches().map(([, init]) => new Headers(init?.headers).get('Save-Id'))
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
  })
})

describe('after a save with no definite answer', () => {
  it('asks the server, and closes the editor when the save went through after all', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/)
    expect(server.patches()).toHaveLength(1)
    expect(server.lookups()).toBe(1)
  })

  it('says "Not saved" for certain when the server never got the save, and fences it', async () => {
    const server = fakeServer(['lose-request'])
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByText('Not saved. The server confirmed this save did not go through.')).toBeInTheDocument()
    expect(capButton('Dee Okafor')).toHaveTextContent(/^40h$/)
    expect(server.hours[4]).toBe(40)
    // A new attempt is a new save, so it isn't caught by the fence.
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(server.hours[4]).toBe(50))
  })

  it('shows "?" and blocks another save of that person while it is checking', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    server.failLookups(true)
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')

    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent('50h ?'))
    expect(capButton('Dee Okafor')).toHaveAccessibleName(/last save not confirmed/)
    expect(capButton('Dee Okafor')).toHaveAttribute('title', expect.stringMatching(/Checking with the server/))
    const deeCell = within(row('Dee Okafor')).getAllByRole('cell')[1]
    expect(deeCell).toHaveAttribute('title', expect.stringContaining('(capacity not confirmed)'))
    expect(screen.getByText(/people over capacity/)).toHaveTextContent('(1 with a capacity not yet confirmed, marked ?)')

    // Retrying now could race the save the server is still settling.
    fireEvent.submit(screen.getByLabelText('Weekly hours for Dee Okafor').closest('form')!)
    expect(server.patches()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(capButton('Dee Okafor')).toBeDisabled()
  })

  it('keeps the doubt when the server cannot tell, until a save of that person is confirmed', async () => {
    const server = fakeServer(['store-and-lose-answer', 'refuse', 'store', 'store'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    server.failLoads(true) // so the grid keeps showing 40
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      try {
        return await original(url, init)
      } finally {
        if (init?.method === 'PATCH') server.restart() // the API restarts before anyone can ask
      }
    })
    await edit('Dee Okafor', '50')
    expect(await screen.findByText(/can't tell whether it went through/)).toBeInTheDocument()
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent('40h ?'))
    vi.mocked(fetch).mockImplementation(original)

    // A definite "Not saved" for a retry doesn't settle the earlier save...
    await edit('Dee Okafor', '50')
    await screen.findByText(/Not saved. could not update person/)
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')
    // ...and neither does a confirmed save of someone else.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await edit('Ana Ferreira', '36')
    await waitFor(() => expect(capButton('Ana Ferreira')).toHaveTextContent(/^36h$/))
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')

    // Going back to 40 must reach the server instead of looking "unchanged".
    await edit('Dee Okafor', '40')
    await waitFor(() => expect(server.hours[4]).toBe(40))
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^40h$/))
  })

  it('shows the warning and the doubt together in the editor', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    server.failLookups(true)
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')
    fireEvent.change(screen.getByLabelText('Weekly hours for Dee Okafor'), { target: { value: '45' } })
    expect(screen.getByText('Changes capacity for every week, past and future.')).toBeInTheDocument()
    expect(screen.getByText(/Checking with the server/)).toBeInTheDocument()
    expect(screen.getByText(/weekly hours \(now/)).toHaveTextContent('?')
  })
})

describe("someone else's save in progress", () => {
  it('shows "?" until the server has settled it, and refreshes by itself', async () => {
    const server = fakeServer([], { saving: [1] })
    renderGrid()
    await screen.findByText('Ana Ferreira', { selector: 'th' })
    expect(capButton('Ana Ferreira')).toHaveTextContent('40h ?')
    expect(capButton('Ana Ferreira')).toHaveAttribute('title', expect.stringMatching(/in progress on the server/))
    expect(capButton('Ana Ferreira')).toBeDisabled()

    server.stopSaving()
    server.hours[1] = 36
    await waitFor(() => expect(capButton('Ana Ferreira')).toHaveTextContent(/^36h$/), { timeout: 4000 })
    expect(capButton('Ana Ferreira')).toBeEnabled()
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
