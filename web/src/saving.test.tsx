import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapacityResponse } from './api'
import { CapacityGrid } from './CapacityGrid'

// What the manager is told after a save, and what the editor lets them do.
// The rule: "Not saved" only when our API said so; anything else is unknown.

const capacity: CapacityResponse = {
  weeks: ['2026-01-05', '2026-01-12'],
  people: [
    { id: 1, name: 'Ana Ferreira', weeklyHours: 40, allocated: [0, 30] },
    { id: 4, name: 'Dee Okafor', weeklyHours: 40, allocated: [45, 40] },
  ],
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Patch = (init: RequestInit) => Promise<Response>

function setup(patch: Patch) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PATCH' ? patch(init) : json(200, capacity),
  )
  vi.stubGlobal('fetch', fetchMock)
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PATCH').length
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  return { fetchMock, gets, patches }
}

async function saveDee(value: string) {
  const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
  if (!screen.queryByLabelText('Weekly hours for Dee Okafor')) {
    fireEvent.click(within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ }))
  }
  fireEvent.change(screen.getByLabelText('Weekly hours for Dee Okafor'), { target: { value } })
  fireEvent.submit(screen.getByLabelText('Weekly hours for Dee Okafor').closest('form')!)
  return dee
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('what a failed save says', () => {
  it.each([
    ['our API refuses it (404)', () => json(404, { error: 'person not found' }), 'Not saved. person not found'],
    [
      'our API gives up on the database (503 with its JSON error)',
      () => json(503, { error: "the database didn't respond in time" }),
      "Not saved. the database didn't respond in time",
    ],
  ])('says "Not saved" when %s', async (_, response, message) => {
    setup(async () => response())
    const dee = await saveDee('50')
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(within(dee).getByText('+5')).toBeInTheDocument()
  })

  it.each([
    ['a proxy answers with an HTML 502', async () => new Response('<html>Bad Gateway</html>', { status: 502 })],
    ['the save times out', async () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'))],
    ['a 200 arrives unreadable', async () => new Response('{"id": 4,', { status: 200 })],
  ])('does not claim "Not saved" when %s', async (_, patch) => {
    setup(patch)
    await saveDee('50')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't confirm the save")
    expect(alert).not.toHaveTextContent('Not saved')
  })

  it('times a save out instead of waiting forever', async () => {
    const { patches } = setup(async () => json(200, { id: 4, name: 'Dee Okafor', weeklyHours: 50 }))
    await saveDee('50')
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('names the timeout and lets the manager cancel afterwards', async () => {
    setup(() => Promise.reject(new DOMException('signal timed out', 'TimeoutError')))
    await saveDee('50')
    expect(await screen.findByRole('alert')).toHaveTextContent("didn't answer within 15 seconds")
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('after a save with no definite answer', () => {
  it('sends the old value again instead of assuming it is still stored', async () => {
    // The server stored 50 but the answer was lost. Going back to 40 must
    // reach the server, even though 40 is the last value it confirmed.
    let first = true
    const { patches } = setup(async () => {
      if (first) {
        first = false
        throw new TypeError('Failed to fetch')
      }
      return json(200, { id: 4, name: 'Dee Okafor', weeklyHours: 40 })
    })
    await saveDee('50')
    await screen.findByRole('alert')

    await saveDee('40')
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[1][1]?.body).toBe(JSON.stringify({ weeklyHours: 40 }))
  })

  it('reloads the range on Cancel, so the grid shows what the server has', async () => {
    const { gets } = setup(async () => {
      throw new TypeError('Failed to fetch')
    })
    await saveDee('50')
    await screen.findByRole('alert')
    const before = gets()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(gets()).toBe(before + 1))
  })

  it('does not reload on Cancel after a definite "Not saved"', async () => {
    const { gets } = setup(async () => json(500, { error: 'could not update person' }))
    await saveDee('50')
    await screen.findByRole('alert')
    const before = gets()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(gets()).toBe(before)
  })
})

describe('the editor', () => {
  it('sends nothing when the value is unchanged', async () => {
    const { patches } = setup(async () => json(200, {}))
    await saveDee('40')
    await waitFor(() => expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument())
    expect(patches()).toHaveLength(0)
  })

  it('cannot be cancelled, edited or escaped while a save is in flight', async () => {
    let finish!: (r: Response) => void
    setup(() => new Promise((resolve) => (finish = resolve)))
    await saveDee('50')
    await screen.findByRole('button', { name: 'Saving…' })

    const input = screen.getByLabelText('Weekly hours for Dee Okafor')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toBeInTheDocument()

    await act(async () => finish(json(200, { id: 4, name: 'Dee Okafor', weeklyHours: 50 })))
  })

  it('returns focus to the capacity button when it closes', async () => {
    setup(async () => json(200, {}))
    const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
    const button = within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ })
    fireEvent.click(button)
    const input = screen.getByLabelText('Weekly hours for Dee Okafor')
    expect(input).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    await waitFor(() => expect(button).toHaveFocus())
  })

  it("doesn't take focus back when its row is filtered out and back in", async () => {
    setup(async () => json(200, {}))
    const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
    fireEvent.click(within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ }))

    const search = screen.getByLabelText('Find person')
    search.focus()
    fireEvent.change(search, { target: { value: 'ana' } })
    expect(screen.queryByLabelText('Weekly hours for Dee Okafor')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toBeInTheDocument()
    expect(search).toHaveFocus()
  })

  it('shows a failed save whose row is out of sight, and brings the row back', async () => {
    let fail!: (r: Response) => void
    setup(() => new Promise((resolve) => (fail = resolve)))
    await saveDee('50')
    await screen.findByRole('button', { name: 'Saving…' })

    fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'ana' } })
    await act(async () => fail(json(500, { error: 'could not update person' })))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("The weekly hours for Dee Okafor weren't saved as asked. Not saved.")
    fireEvent.click(within(banner).getByRole('button', { name: 'Show' }))
    expect(screen.getByLabelText('Find person')).toHaveValue('')
    expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toHaveValue(50)
  })
})
