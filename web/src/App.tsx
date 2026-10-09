import { useEffect, useState } from 'react'
import { CapacityGrid } from './CapacityGrid'
import { isSupportedDate, limitWeeks, todayISO, weekRange, weeksFrom, type WeekRange } from './dates'

const DEFAULT_WEEKS = 8

// The range lives in the URL (?from=&to=) so a view can be shared or reloaded.
// Without one, the grid starts at the current week: managers look ahead.
function rangeFromURL(): WeekRange {
  const params = new URLSearchParams(window.location.search)
  const from = params.get('from')
  const to = params.get('to')
  if (isSupportedDate(from) && isSupportedDate(to)) return limitWeeks(weekRange(from, to))
  return weeksFrom(todayISO(), DEFAULT_WEEKS)
}

export function App() {
  const [range, setRange] = useState(rangeFromURL)

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('from', range.from)
    url.searchParams.set('to', range.to)
    window.history.replaceState(null, '', url)
  }, [range])

  return (
    <main>
      <h1>Team capacity</h1>
      <CapacityGrid from={range.from} to={range.to} onRangeChange={(next) => setRange(limitWeeks(next))} />
    </main>
  )
}
