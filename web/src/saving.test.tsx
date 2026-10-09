import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacityGrid } from './CapacityGrid'

// What the manager is told after a save, what the grid shows afterwards, and
// where focus goes. The rule: "Not saved" only when our API said nothing was
// stored; otherwise the outcome is unknown, and the grid reloads to find out.
//
// A small fake server with state, so a test can check what the grid shows
// against what the server really holds — a mock that always answers the same
// can't model "the save was stored but its answer was lost".

type Outcome =
  | 'store' // store it and answer 200
  | 'store-and-lose-answer' // store it, then the connection drops
  | 'refuse' // our API's JSON 500: nothing stored
  | 'commit-unknown' // our API's JSON 500 saying it can't tell
  | 'html-500' // a proxy's error page: unknown
  | 'hold' // never answers until released
  | 'timeout' // the client gives up waiting

function fakeServer(outcomes: Outcome[]) {
  const hours: Record<number, number> = { 1: 40, 4: 40 }
  const names: Record<number, string> = { 1: 'Ana Ferreira', 4: 'Dee Okafor' }
  const allocated: Record<number, number[]> = { 1: [0, 30], 4: [45, 40] }
  let failLoads = false
  let release: (() => void) | null = null
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PATCH') {
      if (failLoads) return new Response('<html>Bad Gateway</html>', { status: 502 })
      return json(200, {
        weeks: ['2026-01-05', '2026-01-12'],
        people: [1, 4].map((id) => ({ id, name: names[id], weeklyHours: hours[id], allocated: allocated[id] })),
      })
    }
    const id = Number(url.split('/').pop())
    const value = JSON.parse(String(init.body)).weeklyHours as number
    const outcome = outcomes.shift() ?? 'store'
    switch (outcome) {
      case 'store':
        hours[id] = value
        return json(200, { id, name: names[id], weeklyHours: value })
      case 'store-and-lose-answer':
        hours[id] = value
        throw new TypeError('Failed to fetch')
      case 'refuse':
        return json(500, { error: 'could not update person' })
      case 'commit-unknown':
        hours[id] = value
        return json(500, { error: "the save couldn't be confirmed", stored: 'unknown' })
      case 'html-500':
        return new Response('<html>Internal Server Error</html>', { status: 500 })
      case 'timeout':
        throw new DOMException('signal timed out', 'TimeoutError')
      case 'hold':
        await new Promise<void>((resolve) => (release = resolve))
        hours[id] = value
        return json(200, { id, name: names[id], weeklyHours: value })
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    hours,
    patches: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    loads: () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PATCH').length,
    failLoads: (fail: boolean) => (failLoads = fail),
    release: () => release?.(),
  }
}

// Scoped to the row header: the editor panel's title repeats the name.
const capButton = (name: string) =>
  within(screen.getByText(name, { selector: 'th' }).closest('tr')!).getByRole('button', {
    name: new RegExp(`Weekly hours for ${name}`),
  })

async function edit(name: string, value: string) {
  await screen.findByText(name, { selector: 'th' })
  if (!screen.queryByLabelText(`Weekly hours for ${name}`)) fireEvent.click(capButton(name))
  const input = screen.getByLabelText(`Weekly hours for ${name}`)
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(input.closest('form')!)
}

function renderGrid() {
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what a failed save says', () => {
  it('says "Not saved" when our API refused it', async () => {
    fakeServer(['refuse'])
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. could not update person')
  })

  it.each([
    ['the answer is lost', 'store-and-lose-answer' as Outcome],
    ['our API itself cannot tell (lost COMMIT)', 'commit-unknown' as Outcome],
    ["a proxy's HTML page answers, even with a 500", 'html-500' as Outcome],
  ])('says "Couldn\'t confirm" when %s', async (_, outcome) => {
    fakeServer([outcome])
    renderGrid()
    await edit('Dee Okafor', '50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't confirm the save")
    expect(alert).not.toHaveTextContent('Not saved')
  })

  it('says "Couldn\'t confirm" on a timeout, and lets the manager cancel', async () => {
    fakeServer(['timeout'])
    renderGrid()
    await edit('Dee Okafor', '50')
    expect(await screen.findByRole('alert')).toHaveTextContent("didn't answer within 15 seconds")
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('gives a save 15 seconds, longer than the API gives the database (10 s)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fakeServer(['store'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000))
  })
})

describe('after a save with no definite answer', () => {
  it('reloads at once, so the grid shows what the server holds, whatever the manager does next', async () => {
    const server = fakeServer(['store-and-lose-answer'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')

    // Going straight to someone else's editor (no Cancel, no Escape) used to
    // drop the uncertainty silently, leaving Dee at 40h while the server held 50.
    fireEvent.click(capButton('Ana Ferreira'))
    await waitFor(() => expect(capButton('Dee Okafor')).toHaveTextContent('50h'))
    expect(server.hours[4]).toBe(50)
  })

  it('a later "Not saved" does not erase the earlier uncertainty', async () => {
    const server = fakeServer(['store-and-lose-answer', 'refuse'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    server.failLoads(true) // so the reload can't settle it

    await edit('Dee Okafor', '50') // stored, answer lost
    await screen.findByText(/Couldn't confirm/)
    await edit('Dee Okafor', '50') // retry: refused, nothing stored this time
    await screen.findByText(/Not saved/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // The grid still says 40, the server holds 50: the person is marked, and
    // going back to 40 must reach the server instead of looking "unchanged".
    expect(capButton('Dee Okafor')).toHaveTextContent('40h ?')
    await edit('Dee Okafor', '40')
    await waitFor(() => expect(server.patches()).toHaveLength(3))
    await waitFor(() => expect(server.hours[4]).toBe(40))
  })

  it('does not reload after a definite "Not saved"', async () => {
    const server = fakeServer(['refuse'])
    renderGrid()
    await screen.findByText('Dee Okafor', { selector: 'th' })
    const before = server.loads()
    await edit('Dee Okafor', '50')
    await screen.findByRole('alert')
    await new Promise((r) => setTimeout(r, 20))
    expect(server.loads()).toBe(before)
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

  it('cannot be cancelled, edited or escaped while a save is in flight', async () => {
    const server = fakeServer(['hold'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })

    const input = screen.getByLabelText('Weekly hours for Dee Okafor')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    expect(capButton('Ana Ferreira')).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toBeInTheDocument()

    await act(async () => server.release())
  })

  it('finishes a save whose row was filtered out meanwhile', async () => {
    const server = fakeServer(['hold'])
    renderGrid()
    await edit('Dee Okafor', '50')
    await screen.findByRole('button', { name: 'Saving…' })
    fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'ana' } })
    expect(screen.queryByText('Dee Okafor', { selector: 'th' })).not.toBeInTheDocument()
    await act(async () => server.release())
    // Saved: the panel closes even though the row is out of sight.
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

  it('goes to the grid when the saved row has left the filtered list', async () => {
    fakeServer(['store'])
    renderGrid()
    fireEvent.click(await screen.findByLabelText('Only over capacity'))
    await edit('Dee Okafor', '50') // 45 of 50 is no longer over: her row leaves the list
    await waitFor(() => expect(screen.getByRole('region', { name: 'Capacity by person and week' })).toHaveFocus())
  })
})
