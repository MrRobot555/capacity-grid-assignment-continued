import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CapacityResponse } from './api'
import { CapacityGrid } from './CapacityGrid'

const capacity: CapacityResponse = {
  weeks: ['2026-01-05', '2026-01-12'],
  people: [
    { id: 1, name: 'Ana Ferreira', weeklyHours: 40, allocated: [0, 30] },
    { id: 4, name: 'Dee Okafor', weeklyHours: 40, allocated: [45, 40] },
  ],
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The editing flow end to end: a failed save must leave every number on screen
// as the server has it, and a successful retry must update every number that
// depends on the edited person, without reloading the range.
it('keeps the grid honest through a failed save and a successful retry', async () => {
  const patchResponses = [
    json(500, { error: 'could not update person' }),
    // The server stores 48 for a typed 50 (say it rounds): the grid must show
    // what the server holds, not what was typed.
    json(200, { id: 4, name: 'Dee Okafor', weeklyHours: 48 }),
  ]
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PATCH' ? patchResponses.shift()! : json(200, capacity),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)

  const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
  const firstWeekHeader = screen.getByRole('columnheader', { name: /5 Jan/ })
  expect(firstWeekHeader).toHaveTextContent('1 over')
  expect(within(dee).getByText('+5')).toBeInTheDocument()
  expect(screen.getByText(/people over capacity/)).toHaveTextContent('1 of 2 people over capacity')

  fireEvent.click(within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ }))
  fireEvent.change(screen.getByLabelText('Weekly hours for Dee Okafor'), { target: { value: '50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  // Failed: the error is shown, the typed value is kept, the grid is unchanged.
  expect(await screen.findByRole('alert')).toHaveTextContent('could not update person')
  expect(screen.getByLabelText('Weekly hours for Dee Okafor')).toHaveValue(50)
  expect(within(dee).getByText('+5')).toBeInTheDocument()
  expect(firstWeekHeader).toHaveTextContent('1 over')

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  // Confirmed: the capacity, the cell and the column count all follow.
  await waitFor(() => expect(within(dee).getByRole('button', { name: /Weekly hours/ })).toHaveTextContent('48h'))
  expect(within(dee).queryByText('+5')).not.toBeInTheDocument()
  expect(firstWeekHeader).toHaveTextContent('none over')
  expect(screen.getByText(/people over capacity/)).toHaveTextContent('0 of 2 people over capacity')

  // ...from the PATCH response, not by reloading the range.
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PATCH')).toHaveLength(1)
})

it('shows a reachable error and a retry when the range fails to load', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))
    .mockResolvedValueOnce(json(200, capacity))
  vi.stubGlobal('fetch', fetchMock)

  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)

  expect(await screen.findByRole('alert')).toHaveTextContent("The server couldn't handle the request (502)")
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Dee Okafor')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

// A failed save must never be silent. If another editor could open while one
// save is in flight, that save's failure would have nowhere to be shown.
it('does not let a second edit start while a save is in flight', async () => {
  let failSave!: (r: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((resolve) => (failSave = resolve))
        : Promise.resolve(json(200, capacity)),
    ),
  )
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)

  const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
  const ana = screen.getByText('Ana Ferreira').closest('tr')!
  fireEvent.click(within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ }))
  fireEvent.change(screen.getByLabelText('Weekly hours for Dee Okafor'), { target: { value: '50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('button', { name: 'Saving…' })

  expect(within(ana).getByRole('button', { name: /Weekly hours for Ana Ferreira/ })).toBeDisabled()

  failSave(json(500, { error: 'could not update person' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. could not update person')
})

// Rows are virtualised, so the browser's find-in-page can't reach most names.
it('finds people by name, ignoring case and accents', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(200, {
        ...capacity,
        people: [...capacity.people, { id: 9, name: 'Søren Öberg', weeklyHours: 40, allocated: [0, 0] }],
      }),
    ),
  )
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  await screen.findByText('Søren Öberg')

  fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'soren ob' } })
  expect(screen.getByText('Søren Öberg')).toBeInTheDocument()
  expect(screen.queryByText('Dee Okafor')).not.toBeInTheDocument()

  fireEvent.change(screen.getByLabelText('Find person'), { target: { value: 'OKA' } })
  expect(screen.getByText('Dee Okafor')).toBeInTheDocument()
  expect(screen.queryByText('Søren Öberg')).not.toBeInTheDocument()
})

// A save whose response never arrives may still have been stored: saying "Not
// saved" would be a guess. Saying so plainly, and offering a safe retry, isn't.
it('does not claim a save failed when the answer was lost', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new TypeError('Failed to fetch')
      return json(200, capacity)
    }),
  )
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  const dee = (await screen.findByText('Dee Okafor')).closest('tr')!
  fireEvent.click(within(dee).getByRole('button', { name: /Weekly hours for Dee Okafor/ }))
  fireEvent.change(screen.getByLabelText('Weekly hours for Dee Okafor'), { target: { value: '50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent("Couldn't confirm the save")
  expect(alert).not.toHaveTextContent('Not saved')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(within(dee).getByText('+5')).toBeInTheDocument()
})
