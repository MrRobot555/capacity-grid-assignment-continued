import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

it('shows a skeleton on the first load, when there is nothing to keep on screen', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  expect(screen.getByLabelText('Loading capacity')).toBeInTheDocument()
})

it("hides the over-capacity count while the grid still shows the previous range", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(json(200, capacity)).mockReturnValue(new Promise(() => {}))
  vi.stubGlobal('fetch', fetchMock)
  const { rerender } = render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  expect(await screen.findByText(/people over capacity/)).toBeInTheDocument()

  rerender(<CapacityGrid from="2026-01-12" to="2026-01-25" onRangeChange={() => {}} />)
  expect(screen.queryByText(/people over capacity/)).not.toBeInTheDocument()
  expect(screen.getByText('Dee Okafor')).toBeInTheDocument()
})

it('filters to people over capacity in any week shown', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, capacity)))
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)
  await screen.findByText('Ana Ferreira')
  fireEvent.click(screen.getByLabelText('Only over capacity'))
  expect(screen.queryByText('Ana Ferreira')).not.toBeInTheDocument()
  expect(screen.getByText('Dee Okafor')).toBeInTheDocument()
})

it('says "1 week", not "1 weeks"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { ...capacity, weeks: ['2026-01-05'] })))
  render(<CapacityGrid from="2026-01-05" to="2026-01-11" onRangeChange={() => {}} />)
  expect(screen.getByRole('option', { name: '1 week' })).toBeInTheDocument()
})

// The bug was in what the grid passes as the load's identity (the range key,
// which repeats on Retry), so this is tested through the grid, not the hook.
it('starts "slow" afresh when a slow load is retried', async () => {
  let failSlowLoad!: () => void
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() => new Promise((_, reject) => (failSlowLoad = () => reject(new TypeError('Failed to fetch')))))
    .mockImplementation(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetchMock)
  render(<CapacityGrid from="2026-01-05" to="2026-01-18" onRangeChange={() => {}} />)

  expect(await screen.findByText(/Still loading/, {}, { timeout: 2500 })).toBeInTheDocument()
  await act(async () => failSlowLoad())
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

  expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  expect(screen.getByRole('status')).not.toHaveTextContent('Still loading')
})
