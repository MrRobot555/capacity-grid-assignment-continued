import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapacityGrid } from './CapacityGrid'
import { retryTiming, SAVE_ATTEMPTS } from './useCapacity'

// What the manager is told after a save, what the grid shows, and where focus
// goes. "Not saved" only when the server said nothing was stored. A save sends
// the version it loaded (If-Match); when its answer is lost, the identical
// request is sent again. The repeat applies if the first attempt never landed,
// or meets a newer version and gets the current row back (412).
//
// A fake server with state that enforces If-Match like the API (api/people.go):
// every stored change gives the row a new version.

type Outcome =
  | 'store' // store it and answer 200
  | 'store-and-lose-answer' // store it, then the connection drops
  | 'lose-request' // the request never reaches the API
  | 'refuse' // our API's JSON 500 before it could even try (e.g. no database connection): nothing stored
  | 'commit-unknown' // stored, but the API couldn't tell (its COMMIT got no answer)
  | 'html-500' // a proxy's error page after the API stored it
  | 'timeout' // stored, but the client gave up waiting
  | 'no-answer' // the client gave up waiting, and nothing was stored
  | 'hold' // stores and answers only when released

type Row = { id: number; name: string; weeklyHours: number; version: string }

function fakeServer(outcomes: Outcome[]) {
  const hours: Record<number, number> = { 1: 40, 4: 40 }
  const versions: Record<number, number> = { 1: 1, 4: 1 }
  const names: Record<number, string> = { 1: 'Ana Ferreira', 4: 'Dee Okafor' }
  const allocated: Record<number, number[]> = { 1: [0, 30], 4: [45, 40] }
  let release: (() => void) | null = null
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const row = (id: number): Row => ({ id, name: names[id], weeklyHours: hours[id], version: `v${versions[id]}` })
  const set = (id: number, value: number) => {
    hours[id] = value
    versions[id]++
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') {
      return json(200, {
        weeks: ['2026-01-05', '2026-01-12'],
        people: [1, 4].map((id) => ({ ...row(id), allocated: allocated[id] })),
      })
    }
    const id = Number(url.split('/').pop())
    const ifMatch = (new Headers(init.headers).get('If-Match') ?? '').replaceAll('"', '')
    const value = JSON.parse(String(init.body)).weeklyHours as number
    const outcome = outcomes.shift() ?? 'store'
    if (outcome === 'lose-request') throw new TypeError('Failed to fetch')
    if (outcome === 'no-answer') throw new DOMException('signal timed out', 'TimeoutError')
    if (outcome === 'refuse') return json(500, { error: 'could not update person' })
    if (ifMatch !== row(id).version) {
      return json(412, { error: 'the weekly hours were changed on the server since they were loaded', current: row(id) })
    }
    switch (outcome) {
      case 'store':
        set(id, value)
        return json(200, row(id))
      case 'store-and-lose-answer':
        set(id, value)
        throw new TypeError('Failed to fetch')
      case 'commit-unknown':
        set(id, value)
        return json(500, { error: "the save couldn't be confirmed", stored: 'unknown' })
      case 'html-500':
        set(id, value)
        return new Response('<html>Internal Server Error</html>', { status: 500 })
      case 'timeout':
        set(id, value)
        throw new DOMException('signal timed out', 'TimeoutError')
      case 'hold':
        await new Promise<void>((resolve) => (release = resolve))
        set(id, value)
        return json(200, row(id))
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    hours,
    /** Someone else changes the row (a new version), outside this grid. */
    changeElsewhere: set,
    patches: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ifMatches: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => new Headers(init?.headers).get('If-Match')),
    release: () => release?.(),
  }
}

// Scoped to the row header: the editor panel's title repeats the name.
const rowOf = (name: string) => screen.getByText(name, { selector: 'th' }).closest('tr')!
const capButton = (name: string) =>
  within(rowOf(name)).getByRole('button', { name: new RegExp(`Weekly hours for ${name}`) })

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
  vi.useRealTimers()
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
  ])('sends the identical save again when %s, stores it once, and never says "Not saved"', async (_, outcome) => {
    const server = fakeServer([outcome])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument()
    const sent = server.ifMatches()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0]) // the identical request, with the version first loaded
    expect(server.hours[4]).toBe(50)
    expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/)
  })

  it(`gives up after ${SAVE_ATTEMPTS} attempts without a definite answer, and says so`, async () => {
    const server = fakeServer(Array(SAVE_ATTEMPTS).fill('no-answer'))
    renderGrid()
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't confirm the save")
    expect(alert).toHaveTextContent("didn't answer within 15 seconds")
    expect(alert).not.toHaveTextContent('Not saved')
    expect(server.patches()).toHaveLength(SAVE_ATTEMPTS)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('waits 1, 2, 4 and 8 seconds between the 5 attempts', async () => {
    retryTiming.delay = realDelay
    const server = fakeServer(Array(5).fill('no-answer'))
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    fireEvent.click(capButton('Dee Okafor'))
    const input = screen.getByLabelText('Weekly hours for Dee Okafor')
    fireEvent.change(input, { target: { value: '50' } })
    // Fake only setTimeout, and only from here: the waits under test use it.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    fireEvent.submit(input.closest('form')!)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.patches()).toHaveLength(1)
    for (const [wait, attempts] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5]]) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(server.patches()).toHaveLength(attempts - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.patches()).toHaveLength(attempts)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.patches()).toHaveLength(5)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't confirm the save")
  })

  it('gives each attempt 15 seconds, longer than the API gives it (12 s)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000))
  })

  it('sends the version it loaded, and the stored version next time', async () => {
    const server = fakeServer(['store', 'store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/))
    await edit('Dee Okafor', '45')
    await waitFor(() => expect(server.patches()).toHaveLength(2))
    expect(server.ifMatches()).toEqual(['"v1"', '"v2"'])
  })

  it('ends the save with a message if something unexpected throws', async () => {
    fakeServer(['lose-request'])
    retryTiming.delay = () => {
      throw new Error('boom')
    }
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong while saving')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('when the row changed on the server', () => {
  // Another manager saved Dee after this grid loaded her: a save on the old
  // version must not overwrite theirs, and must say so.
  it('refuses to overwrite someone else\'s change, shows it, and keeps the typed value', async () => {
    const server = fakeServer([])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    server.changeElsewhere(4, 30)
    await edit('Dee Okafor', '50')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: the weekly hours were changed on the server since you loaded them (now 30h)',
    )
    expect(server.hours[4]).toBe(30)
    expect(capButton('Dee Okafor')).toHaveTextContent(/^30h$/)
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toHaveValue(50)

    // Saving again now is a deliberate choice, made on the current version.
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(server.hours[4]).toBe(50))
  })

  // The first attempt is lost; before the repeat, another manager saves 30.
  // The repeat must neither overwrite 30 nor claim either outcome for ours.
  it('does not let a repeat overwrite a change made in between', async () => {
    const server = fakeServer(['lose-request'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    const original = vi.mocked(fetch).getMockImplementation()!
    let patches = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH' && ++patches === 2) server.changeElsewhere(4, 30)
      return original(url, init)
    })
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed the weekly hours on the server (now 30h)')
    expect(alert).toHaveTextContent('your earlier attempt may have been stored before that')
    expect(alert).not.toHaveTextContent('Not saved')
    expect(server.hours[4]).toBe(30)
    expect(capButton('Dee Okafor')).toHaveTextContent(/^30h$/)
  })

  // Our first attempt IS stored but its answer is lost; then another manager
  // changes it. "Not saved" would be false: ours landed, then theirs.
  it('never says "Not saved" when our earlier attempt may have landed before their change', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    const original = vi.mocked(fetch).getMockImplementation()!
    let patches = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH' && ++patches === 2) server.changeElsewhere(4, 30)
      return original(url, init)
    })
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('Not saved')
    expect(alert).toHaveTextContent('your earlier attempt may have been stored')
    expect(capButton('Dee Okafor')).toHaveTextContent(/^30h$/)
  })

  // Someone re-saved the same value: the version moved, the hours didn't.
  it('says the row was saved again, not "changed", when only the version moved', async () => {
    const server = fakeServer([])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    server.changeElsewhere(4, 40)
    await edit('Dee Okafor', '45')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('someone else saved these weekly hours meanwhile (still 40h)')
    expect(alert).not.toHaveTextContent('were changed')
  })
})

describe('when a repeat is refused after an unknown outcome', () => {
  // The first attempt IS stored, its answer lost; the repeat can't even run
  // (no database connection). "Not saved" would be false, and nothing is
  // being sent any more, so "Sending it again" must not stay either.
  it('says the save could not be confirmed, and the "?" says so too', async () => {
    const server = fakeServer(['store-and-lose-answer', 'refuse'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      // Keep the grid from reloading the stored 50 meanwhile.
      init?.method === 'PATCH' ? original(url, init) : new Response('<html>Bad Gateway</html>', { status: 502 }),
    )
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't confirm the save")
    expect(alert).not.toHaveTextContent('Not saved')
    expect(server.hours[4]).toBe(50)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')
    expect(capButton('Dee Okafor')).toHaveAttribute('title', expect.stringMatching(/may hold a different value/))
    expect(capButton('Dee Okafor')).not.toHaveAttribute('title', expect.stringMatching(/Sending it again/))
  })
})

describe('while a save is being sent again', () => {
  it('shows "?" and says why, and keeps every editor closed to new saves', async () => {
    // The first attempt never arrives, so the repeat applies (and is held).
    const server = fakeServer(['lose-request', 'hold'])
    renderGrid()
    await edit('Dee Okafor', '50')

    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent('40h ?'))
    expect(capButton('Dee Okafor')).toHaveAccessibleName(/last save not confirmed/)
    expect(capButton('Dee Okafor')).toHaveAttribute('title', expect.stringMatching(/Sending it again/))
    const deeCell = within(rowOf('Dee Okafor')).getAllByRole('cell')[1]
    expect(deeCell).toHaveAttribute('title', expect.stringContaining('(capacity not confirmed)'))
    expect(screen.getByText(/people over capacity/)).toHaveTextContent('(1 with a capacity not yet confirmed, marked ?)')
    expect(screen.getByText('Changes capacity for every week, past and future.')).toBeInTheDocument()
    expect(screen.getByText(/Sending it again/, { selector: '.cap-editor p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true')
    expect(capButton('Ana Ferreira')).toBeDisabled()

    await act(async () => server.release())
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent(/^50h$/))
  })
})

describe('after giving up', () => {
  it('keeps "?" until a save of that person is confirmed, and a repeat of the old value reaches the server', async () => {
    const server = fakeServer([...Array(SAVE_ATTEMPTS).fill('lose-request'), 'store', 'store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByText(/Couldn't confirm the save/)
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
