# Worklog

Running notes on how this got built — decisions, assumptions, dead ends, and anything
left unfinished. Append as you go; a line or two per entry is right.

---

## 2026-10-09 — data probe, before any code

- Every logical assignment is 15 identical-key rows (14×h + 1×2h) summing to 2/4/5/6/8 h/day. Allocation must SUM all rows; any dedupe gives Ana 0.5h/day instead of 8.
- `hours_per_day` counts working days only. Ana's Atlas runs Mon 12-29 → Sun 01-04 at 8h/day: 40/40 on weekdays, 56/40 on calendar days. 3,111 assignments end on a weekend; counting them nearly triples the over-allocated person-weeks (1,626 → 4,779). Decision: Mon–Fri only.
- Fixture people 1–5 hold the edge cases: Ana at exactly capacity, Bo with a Fri→Mon assignment across a week boundary, Cem a 20h part-timer, Dee 45/40 from overlapping assignments, Eli with 0 capacity and 20h allocated (no division by capacity).
- Default range starts 2025-12-29, which is ISO 2026-W01. Weeks are keyed by Monday date, never by (year, week number).
- `weekly_hours` has no history, so an edit applies to every week, past ones included. The UI says so.
- Query at full production shape (500 people × 105 weeks): ~600 ms, about half JIT. The existing (start_date, end_date) index only bounds one side of an overlap; a better index is deferred because the schema is fixed.
- Plan: `.notes/plan.md`.
- Save flow decided: confirmed patch. The grid changes only on server confirmation, patched from the PATCH response, so no rollback path is needed. Optimistic was rejected because a failed save would flip colours back. Refetch was rejected because it leaves other cached ranges stale.

## API

- Response: `weeks` (Mondays) plus one row per person, with `weeklyHours` and an `allocated[]` array aligned to `weeks`. Capacity isn't repeated per cell because the schema has one value per person, so an edit changes exactly one field on the client.
- Range is widened to whole weeks: Monday of `from` through the week containing `to` (inclusive). Inverted ranges and anything over 106 weeks get a 400. Errors are always JSON `{error}`.
- Perf: the first version used `generate_series` for weeks. The planner estimates 1000 rows for it and enabled JIT, which was ~370 of ~400 ms for 8 weeks. Passing the Go-computed Mondays as a `date[]` brings it to ~20 ms (8 weeks) / ~160 ms (2 years, all 500 people). Verified with EXPLAIN ANALYZE.
- PATCH validates 0–168, rejects unknown fields and string numbers, returns 404 for an unknown id, and returns the stored row. The DB has no CHECK constraint, so the API is the only guard.
- `api/api_test.go` checks the five fixture people against the seeded DB. Run with `docker compose run --rm -v ./api:/src api go test ./...`.

## Grid

- State is one reducer (`capacityState.ts`). Allocations belong to a range; people (name, weeklyHours) are kept apart, and every colour, bar and "N over" count is derived at render. An edit changes one person record, and every dependent number follows.
- The range is owned by `App` and mirrored to `?from=&to=`, because on the team overview page the timeline would share it. The default is the current week plus the next 7 (managers look ahead). Fixture weeks: `/?from=2025-12-29&to=2026-01-18`.
- Loading: a skeleton only on first load. After that the old grid stays on screen, dimmed, superseded requests are aborted, and responses for any other range are dropped. After 1.5 s the status says the server is slow. A failed load shows an inline banner with Retry and says that the grid still shows the previous range.
- Save race: a load sent before a save was confirmed can't overwrite that person's weekly hours (both are stamped on one counter). Covered in `capacityState.test.ts`.
- Noticed, fixed: names were sorted Öztürk after Yilmaz. Postgres reports en_US.utf8, but the Alpine image uses musl, which collates by byte. Now sorted client-side with `Intl.Collator`.
- Noticed, left alone: the generator starts assignments every third week and none runs over 14 days, so every third week is empty (e.g. 2026-01-12 holds only the fixture people, and 2026-10-12, next week from today, is blank). That is the data, not a query bug: checked week-by-week counts straight from the API.
- Checked the TZ tests can fail: with `todayISO` written as `toISOString().slice(0,10)` and the formatter without `timeZone: 'UTC'`, 3 cases fail in exactly the zones where the bug shows.
- Verified in a real browser (headless Chromium, script in my scratchpad, not committed). Edited Dee to 50: her 45 stopped being red and the "5 Jan" header went from 15 over to 14, and the DB held 50. Then stopped the API container: the save showed "Not saved…" and the grid kept the confirmed values. Navigating showed the banner and kept the previous range. After starting the API, Retry recovered.
- Changed after looking: the editor first covered the row's own cells, the ones you want to watch while deciding. It now opens below the row, and the capacity cell keeps showing the confirmed value while the draft lives in the editor. "Retry" appears only after a server failure, not after a validation message.
- Caught: the TZ test used `process`, which the browser-only tsconfig doesn't type, so `npm run build` failed on the previous commit even though vitest passed. Fixed with a local declaration rather than adding Node types to the app.

## Scale

- Measured before virtualising (headless Chromium, 500 people): 1 year = 26k cells, 2.3 s to first grid, 1.3 s to untick the filter. 2 years = 52k cells, 4 s / 2.6 s. That is 6× worse at a few thousand people.
- Rows are now windowed by hand (fixed 44 px rows, 8 rows overscan, spacer rows above and below). The DOM holds ~20–30 rows at any range, filter toggles take ~0.2 s, and switching to 52 weeks in-app takes ~330 ms, of which the request is ~70 ms. Columns are not windowed: 106 weeks wide is fine.
- Editor state lives in the grid, not the row, so an edit survives its row scrolling out of the window.
- Not built (deferred): range cache with instant back-navigation; sort by "most over"; server-side paging/filtering for rosters well beyond a few thousand; ETag; an index that bounds both sides of the overlap (GiST on `daterange(start_date, end_date, '[]')`), which the schema rule forbids here; browser history entries per range (`replaceState` only, so Back leaves the page).
- `weekly_hours` has no effective date, so changing it rewrites history: last year's over-allocation changes too. The editor says so. A real fix is a capacity table with `valid_from`; then capacity becomes per-week in the API and a save must refetch the range instead of patching.

## Hunting for what the fixture tests can't see (API)

- New method: a day-by-day oracle (`api/oracle_test.go`) expands every assignment into days, drops weekends and buckets with Postgres `date_trunc('week')`. It shares no logic with the query. It agrees on all 500 people × 84 weeks of seeded data plus odd ranges, which is the independent confirmation that the weekday/overlap arithmetic is right everywhere, not just for the 5 fixture people.
- New method: synthetic assignments in a rolled-back transaction, for shapes the seed lacks: weekend-only, Wed→Tue over 3 weeks, across the new year, longer than the range, end before start.
- Found by them, each proven by a failing test first:
  - An assignment with `end_date < start_date` subtracted hours (−18.5h in a week). The seed has none, but the schema allows it and reviewers rebuild with their own copy of the seed. Fixed with `GREATEST(0, …)` on the day count.
  - Fixing that as a `WHERE start_date <= end_date` filter instead made the 2-year query 8× slower (0.16 → 1.3 s): Postgres guesses a third of the rows for column-vs-column comparisons and picked a 13M-comparison nested loop. Caught only because I re-timed after the fix.
  - `PATCH /api/people/99999999999` was a 500 (int4 overflow in Postgres) → now 400. A body with trailing data (`{"weeklyHours":10} x`, or two objects) was accepted and saved → now 400.
- `TestCapacityQueryPlanStaysCheap` gates the plan's causes: no JIT, and under 750 ms for the largest allowed range (~0.2 s today). Checked it can fail: with the slow filter put back it reports 2310 ms.
- My own mistake, caught by the test: I computed "106 weeks from 2026-01-05" as ending 2028-01-02. It is 2028-01-16. The boundary test failed against a correct server.
- Checked and left: year 0000 is accepted (pgx sends it as 1 BC, Postgres takes it). Harmless, so it isn't a 500.

## Hunting (web)

- Exhaustive date tests: every day 2024–2028 in 5 zones (incl. St John's −3:30 and Lord Howe's 30-minute DST) against a day sequence built in pure UTC. They passed first time, which is the evidence the date code is right rather than the absence of a test.
- Found: `Date.UTC` reads years 0–99 as 19xx, and a date input emits years 0002/0020/0202 while you type "2026". Each keystroke fired a request for a nonsense range. Now `setUTCFullYear` is used, date inputs ignore years outside 2000–2099, and ranges from the URL or the pickers are capped at the API's 106 weeks.
- Found: while one save was in flight, another person's editor could be opened. If the first save then failed, its error was dropped (the editor had moved on). Now other capacity buttons are disabled until the save settles.
- Found in the browser at a 24px root font, not by unit tests: over-capacity cells wrapped to two lines, so rows were 44 or 47.9 px. Virtualisation assumed one height; my first fix (measure the first row) made the height flip as different rows came first, a render loop that unmounted the grid. Fixed at the cause: every cell is one line and the row height is in rem, so rows are uniform at any font size. The measurement takes the tallest row, so it can't oscillate. Checked at 16 and 24 px: 15 scroll positions, never a blank spacer under the viewport, last person reachable.
- Added "Find person" (case- and accent-insensitive, incl. ø/æ/þ), because virtualised rows are invisible to the browser's find-in-page.
- Moving From past To now keeps the number of weeks instead of collapsing to one.
- Found by reading: the reducer dropped stale responses by range key only, so after A → B → back to A the first A request still counted as current. It was safe only because the hook aborts superseded fetches. The reducer now matches the request (`issuedAt`), not the range. Checked: the new test fails against the key-only check.
- Found by thinking about how saves fail: a save whose response is lost (connection drop, proxy timeout) said "Not saved", but the DB may already hold it. Now only an error from the API itself (4xx, 500) says "Not saved". No answer, or a 502–504 from the proxy, says the save couldn't be confirmed and that retrying is safe: PATCH sets an absolute value, so it's idempotent. The grid keeps showing the last confirmed value either way.

## Browser suite (`e2e/`)

- 17 Playwright tests in real Chromium, with faults injected through `page.route`:
  - out-of-order responses, slow loads, 502 HTML, aborted connections, truncated JSON;
  - failed and lost saves; a late GET racing a save; the editor lock;
  - fixture numbers in UTC−8/+14 and across DST;
  - virtualised rows checked by geometry;
  - one real save round trip, restored afterwards.
- Run with `make up`, then `cd e2e && npm install && npx playwright test`. It runs on the host, not in Compose: Playwright's browsers don't run on the Alpine Node image, and the run environment is fixed.
- A parallel agent wrote it while I hardened the app. I reviewed it before committing.
- Found a bug jsdom can't: `max={168}` triggered Chrome's native validation, which blocked the submit, so typing 169 showed a browser popup instead of the app's message. Fixed with `noValidate`.
- The agent caught its own wrong assumption: it expected one GET on load, but React StrictMode double-mounts in dev, which gives two (the first aborted). The test now asserts that a save adds no GET instead.

## Review round 1 (register: `.notes/review-register.md`)

- Two reviewers in parallel with the tree frozen: one adversarial with reproductions, one auditing gates by mutation (63 mutations, 30 survived at least one suite). 21 findings, all fixed in one commit.
- Corrects my earlier entry on save errors: deciding "Not saved" by status code (502–504 meaning unknown) was the wrong signal. It now depends on who answered. Our API always answers with its JSON `{error}`, which means a definite "Not saved". No answer, a timeout, or a proxy's HTML page means "couldn't confirm". That also lets the API's own timeout use 503 honestly.
- New behaviour worth knowing:
  - saves time out (client 15 s, API 10 s, so the server's answer arrives first);
  - after a "couldn't confirm" save, the old value is always sent again, and Cancel reloads the range;
  - a failed save whose row is scrolled away or filtered out shows a banner with "Show";
  - date fields keep what you type and apply it after a pause, on Enter or when focus leaves.
- Not done: round 2, and one flaky browser test (R1-X1).
