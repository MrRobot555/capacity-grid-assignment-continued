# Plan: capacity grid

Decisions only. Code-level detail lives in the code and its tests.

> **As built (deviations from this plan):**
> - **No multi-range cache.** Only one range is held at a time, and the previous one stays on screen while the next loads. Not built: the cache, instant back-navigation, and "an edit fixes every cached range". The normalized people map and the pre-save-GET rule were kept.
> - **No sort by over-allocation.** There is only the "Only over capacity" filter.
> - **JIT is "tuned" by the query shape**, not by settings: the weeks are passed as a `date[]`. See the worklog.

## 1. What the data actually says (probed 2026-10-09; facts, not assumptions)

| Fact | Evidence | Consequence |
|---|---|---|
| Every logical assignment is **15 rows** (same person/project/dates); 14×h + 1×2h, summing to 2/4/5/6/8 h/day | all 8,413 groups have exactly 15 rows | **SUM every row.** `DISTINCT`, "pick one" or dedupe gives Ana 0.5h/day instead of 8 |
| `hours_per_day` is real hours, per **working day** | Ana: 8h/day, Mon 12-29 → Sun 01-04 = **40h** on a 40h contract, but only if weekends count 0 | **Weekdays only (Mon–Fri).** Counting calendar days gives Ana 56/40 and Bo 48/40, both falsely over. Across the data that is 4,779 over-allocated person-weeks instead of 1,626 |
| 3,111 assignments end on a Sat/Sun; some start Wed/Fri; Bo's runs **Fri → Mon across a week boundary** | fixture rows | Allocation is split per week by working-day overlap, not by start week |
| Week 1 is **2025-12-29**, which crosses a year boundary (ISO 2026-W01) | App default range | Weeks are keyed by their Monday date. Never by `(year, weeknum)` |
| **Eli: 0h capacity, 20h allocated** | people.id=5 | No division by capacity. Show "20 / 0" as over-allocated, never `NaN%`/`Infinity%` |
| Dee: 30h Atlas + 15h Corvus (Wed–Fri) = **45/40** | fixture | The over-allocation case that only shows up from overlapping assignments |
| Cem: 20h part-timer, 4h/day | fixture | Under-allocated case. Capacity is per person, not "40" |
| `weekly_hours` is a single current value with **no history** | schema | Editing capacity rewrites **every** week, past included. The UI must say so |
| Existing index `(start_date, end_date)` only bounds the overlap query on one side | schema | Fine at 126k rows (all people × 2 years ≈ 600 ms, ~half of it JIT). Deferred: a GiST index on `daterange`, or an `end_date` index (we can't touch the schema) |

Expected truth for weeks 12-29 / 01-05 / 01-12. **This is the test fixture:**

| | cap | 12-29 | 01-05 | 01-12 |
|---|---|---|---|---|
| Ana | 40 | 40 (full) | 0 | 30 |
| Bo | 40 | 0 | 32 | 8 |
| Cem | 20 | 0 | 4 | 12 |
| Dee | 40 | 0 | **45 (over)** | 40 (full) |
| Eli | 0 | 0 | **20 (over, no capacity)** | 0 |

## 2. Domain rules (decided)

- **Week** = Monday to Sunday, identified by its Monday. Working days are Mon–Fri. There is no holiday data.
- **Allocated(person, week)** = Σ `hours_per_day` × (working days in [start,end] ∩ [Mon,Fri]).
- **Capacity(person, week)** = `weekly_hours`. It is constant across weeks because the schema has no history.
- **Status**: `over` when allocated > capacity (strictly). `full` when equal. `under` otherwise. 0 capacity with >0 allocated is `over`.
- **Range**: `from`/`to` can be any dates. The server snaps them to whole weeks: Monday of `from`'s week through the week containing `to`. The response echoes the weeks it used. The server rejects inverted ranges and ranges over ~2 years (106 weeks) with 400.

## 3. API contract

`GET /api/capacity?from=YYYY-MM-DD&to=YYYY-MM-DD` →
```json
{ "weeks": ["2025-12-29", "2026-01-05", "2026-01-12"],
  "people": [{ "id": 1, "name": "Ana Ferreira", "weeklyHours": 40, "allocated": [40, 0, 30] }] }
```
- Dense arrays aligned to `weeks`. The full roster always comes back, including people with zero allocation. People are ordered by name, then id.
- Capacity is **not** repeated per cell. It is a person attribute in this schema, so an edit changes exactly one field. *(Talking point: once capacity becomes per-week, through holidays or effective dating, add `capacity: number[]` and switch to refetching on save.)*
- One query: generate the weeks, join assignments by overlap, aggregate, then right-join people × weeks. The SQL lives in the query, not in strings built in Go.

`PATCH /api/people/{id}` with `{ "weeklyHours": 32 }` → `200 { id, name, weeklyHours }`. `400` for a bad id, bad JSON, or a missing/non-finite/out-of-range value (0–168). `404` for an unknown person. The response is the server's canonical row, and the client reconciles from it.

## 4. Client state and data path

- One pure reducer, which is the tested core, plus a thin hook. No state library.
- **People are normalized** (`id → {name, weeklyHours}`). The range-scoped allocation data is cached separately by range key. An edit touches one person record and is therefore correct in **every** cached range and every derived number (cell colour, totals, counts), with no refetch.
- Everything shown is **derived at render** from (allocated, weeklyHours). Nothing derived is stored. That rules out a whole class of "the badge didn't update" bugs.
- **Navigation:** the old grid stays on screen, dimmed, with "Loading…". Superseded requests are aborted, and any response for a range that is no longer current is dropped. Cached ranges show instantly and revalidate in the background.
- **Late GET vs. save race:** a GET that was *issued before* a save confirmed must not overwrite that person's `weeklyHours`. Rule: a person's confirmed edit wins over any response issued before it.
- **Range lives in the URL** (`?from=&to=`), so a reviewer can deep-link to the fixture weeks. The default is the current week plus 7 more.
- **Dates are timezone-safe:** `YYYY-MM-DD` strings with UTC arithmetic only. `new Date('2025-12-29')` combined with local getters shifts the day in negative-offset time zones.

## 5. Editing flow → **DECIDED by owner: confirmed patch**

The manager clicks a person's capacity in the first column and edits it inline. Enter saves, Esc cancels.

- **Recommended: confirmed patch.** The editor shows the typed value with a "saving" state. **The grid only changes once the server confirms**, and then it patches from the PATCH response. On failure, the grid is untouched, and the editor keeps the typed value with an inline error and Retry/Cancel. The principle: *the grid only ever shows what the server holds; the editor shows what you typed.* No rollback logic is needed, and no colours flip red → green → red.
- Alternative: optimistic. The grid changes at once and rolls back on failure. That needs a per-field rollback to the last *confirmed* value (not a snapshot, which would clobber concurrent edits) and per-person request sequencing.
- Alternative: refetch the range after a save. This is simple but wrong for the other cached ranges, and it costs a full roster query per keystroke-save.

## 6. Scale (a few thousand people, up to 2 years)

- Row virtualization (sticky header and name column), because 3,000 × 26 is about 80k cells. An "over-allocated only" filter plus sort by over-allocation, because that is the manager's actual question.
- Deferred and written down: server-side paging and filtering, ETag/conditional GET, the overlap index, and JIT tuning.

## 7. Pins (written against today's code before building)

- **Go integration test** (`api/capacity_test.go`; skips without `DATABASE_URL`; run via `docker compose run --rm -v ./api:/src api go test ./...`): the fixture table in §1, plus range snapping (a Sunday `to`, a Wednesday `from`), 400 for inverted or oversized ranges, and PATCH validation and 404. It fails today with 501. That is the gap.
- **Vitest:** week math (Monday snapping, crossing the year boundary, with `TZ` set to a negative offset), status classification (the 0-capacity case), and the reducer (an edit is reflected in all cached ranges; a failed save leaves the grid unchanged; a stale navigation response is dropped; a pre-save GET doesn't clobber a confirmed edit).

## 8. Build layers (commit after each, suite green)

0. Pins and worklog → 1. GET /capacity → 2. PATCH → 3. Read-only grid with loading, error and stale states → 4. Navigation, range picker and URL → 5. Editing flow → 6. Virtualization and the over-allocated filter → 7. **Open it and check the numbers against §1**, then update the worklog. `DECISIONS.md` is left for you.
