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

## After submission (local branch `post-submission`, not pushed)

- The "flaky" browser test was a real bug. A Go context deadline doesn't stop Postgres: an UPDATE waiting behind a row lock committed after the API had already answered 503 "Not saved". The Go locked-row test sometimes left Cem at 21, so the browser suite, run right after it, failed. Fixed by letting Postgres enforce the limit (`statement_timeout`, set for the save's transaction only): when it cancels the statement, the transaction aborts and nothing is stored. The test now waits 500 ms after releasing the lock before checking. It failed 2/3 runs on the old code and passed 5/5 on the fix.
- Lesson: "flaky" was the wrong word. Each failure was one run's leftover state breaking the next run's precondition. The clue was in the trace: Cem was at 21 *before* the browser test started.
- Also closed my round-1 caveats, each with a test that fails on the old code. Running the hanging test against the old handler needed `go test -timeout`: killing its container released the lock and committed the abandoned save. I restored Cem and diffed every person against `db/seed.sql` afterwards.

## Review round 2 → two redesigns (standing rule: a 3rd recurrence means redesign)

- Round 2 reopened four round-1 items. My fixes had been applied where each bug was reported but not on the parallel paths. Counting per area across the register, two areas had come back five times each, so both were redesigned rather than patched again.
- **Save outcome:**
  - "Outcome unknown" is now per person, in the reducer. Only a confirmed save, or a load issued after the uncertainty, clears it.
  - The range reloads the moment an outcome is unknown.
  - While a person is unconfirmed, their capacity shows "?" and the "unchanged" shortcut is off.
  - One function, `isDefiniteFailure`, decides every message.
  - The API reports a COMMIT that got no answer as `stored: unknown`. Postgres refusing the COMMIT is still a definite failure.
- **Editor:**
  - It moved out of the virtualised rows into one panel above the grid. A row can unmount at any time; an editor inside one kept losing its focus, its error and its place.
  - This removed the off-screen banner, "Show" and scroll-to-row.
  - Focus moves only on the user's own actions, and returns to the row's button (or the grid region, if the row was filtered away) only if it was still in the editor.
- Also: status, overage and text all round through one `hundredths()`. Gates were added for every round-2 test gap.
- The save tests now use a small fake server with state. A mock that always answers 40 can't express "the save was stored but its answer was lost", which is exactly the case that matters.

## Review round 3 → the save-outcome area redesigned a second time

- After its round-2 redesign the area failed three more times (grid, panel title, tooltip), all for one reason. The design assumed "a load issued after the uncertainty proves the server's value". Behind a proxy that gives up without cancelling, the load reads the old value and the save commits a moment later. Counting again from zero after a redesign, three recurrences meant redesigning it again.
- **New premise:** only a confirmed save of that person clears doubt. Loads still refresh the value shown, but the "?" stays until a save is confirmed. Saving again is idempotent, and the note says so.
- **New structure:** one presenter, `capacityView`, used by every place a capacity appears (button, its accessible name, tooltip, cell titles, the panel's title and hint). No display site can claim more than is known.
- **API:** one deadline for the whole save, Begin through Commit. The timeout chain is 10 s (Postgres), 12 s (API), 15 s (client), so the server answers first. The error mapping is one tested function, and a TCP-proxy test that cuts the answer after COMMIT pins `stored: unknown` end to end.
- **Save button:** `aria-disabled` instead of `disabled`. A disabled, focused button drops focus to the page in Chrome.

## Review round 4 → save outcomes made answerable by the server (owner's decision)

- The last gap of the client-only design: doubt lived in one page's memory, so F5 or a second tab showed an unsure value as fact. No client-side storage can cover another tab or another manager, so the owner chose a server-side fix.
- Each save carries a client-chosen `Save-Id`. The API records each outcome and answers `GET /api/saves/{id}`.
  - An id it never saw is fenced (a late request with it is refused), so "not stored" stays true.
  - After a restart it says "unknown" rather than guess. The client echoes the `Server-Instance` it saved through.
- When the API loses the answer to its own COMMIT, it asks Postgres (`pg_xact_status`), so `stored: unknown` now only happens when Postgres can't be reached at all.
- `GET /api/capacity` marks people whose save is in progress (`saving`). Every client shows "?" and refreshes quietly until it settles.
- Client: the person shows "Checking…" and can't be saved again until the server answers. The editor then closes ("stored after all") or says "Not saved" for certain.
- Caught myself: an unsafe "close the connection first" step. pgxpool had already handed the connection back, so it could have closed another request's connection. Removed; pgxpool destroys a released connection that is still in a transaction anyway.
- Gate hygiene: the whole-save-deadline gate caught its mutation but hung for 120 s in cleanup. The request now carries a context that ends at the test's limit.
- Wrote `SCAFFOLD-FINDINGS.md`: where the provided scaffold itself is wrong, each point with a measurement (collation, missing CHECKs, the overlap index, no row version, no server timeouts, the health check leaking DB errors, the seed's undocumented shape) and what it needs.

## Review round 5 → the rule recounted, and a redesign by subtraction (owner's decision)

- Round 5 found 23 issues: the count rose again. The owner asked whether the 3-recurrence rule was being followed. Partly: I had reset the count after each redesign. Counting every occurrence, as the rule says, the save-outcome area had recurred about 12 times, and each of my three redesigns had *added* machinery to the same approach (track the doubt, then reconcile it). The new layers produced the next round's findings. Two examples: `crypto.randomUUID` broke saving over plain HTTP, and the lookup applied an old snapshot as the confirmed value.
- The simpler model was there all along: a save sets an absolute value, so it is idempotent. On a lost answer, send the identical request again (same `Save-Id`) until a definite answer. The API only has to recognise a repeat: stored → answered from the record (never re-applied over a newer change); refused → refused again; unknown → run again. The client never applies a repeat's answer; it reloads.
- Deleted: the lookup endpoint, fencing, instance ids, `pg_xact_status`, the `saving` flag, polling and quiet refresh. Accepted limitation: another tab or manager doesn't see "?" during the seconds of retrying, the same staleness as any concurrent edit.
- Re-measured the reviewer's correction before publishing it: 6,883 of 8,413 assignments span a weekend; 3,111 end on one.
- Memory updated: never reset the recurrence count; a recurring redesign must subtract.
- Caught after the gate check: the "id reusable for another change" mutant let a test's PATCH to person 10 through, and the test's cleanup only restored person 3. The leftover 22h shifted two browser tests' over-counts. Restored person 10, diffed all 500 against the seed, and made that test's cleanup restore every person it could touch, so a mutant can't pollute the seed either.

## Review round 6 → the root found: no row version (owner's decision: xmin)

- The area recurred again in round 6: a repeat could overwrite another manager's change made in between, a late copy could overwrite a later confirmed save, and a restart lost the registry's guarantees. All had one root: the API couldn't tell a repeat of an old change from a current one, because a row has no version, the very gap SCAFFOLD-FINDINGS §5 names.
- Postgres has one anyway: the `xmin` system column changes on every update of a row. No schema change. GET returns it as `version`; a save sends `If-Match`; the UPDATE applies only at that version, otherwise 412 with the current row.
- A lost answer is settled by repeating the identical request: 200 if the first attempt never landed, 412 with our value if it did, 412 with someone else's value if they changed it, and then nothing of ours overwrites it.
- Deleted: the Save-Id registry, replay rules and the `settled` state. As a by-product, two managers can no longer silently overwrite each other; the editor says "changed on the server since you loaded them (now Xh)" and keeps the typed value.
- Gate hygiene: two of my Go gates type-asserted the 412 body unchecked, so a mutant made the test binary panic and the remaining tests never ran. They now fail with a message.

## Review round 7 → an outcome belongs to the save, not to a request

- The `xmin` row version held up under every attack: locks, VACUUM FREEZE/FULL, concurrent uncommitted updates, late copies.
- Both reviewers independently found the client's interpretation wrong. After an attempt whose outcome was unknown, a definite answer to the *repeat* only says what that request did. Yet the client said "Not saved" (the DB held 50), or treated a 412 showing another manager's later value as proof that ours never landed.
- Fixed structurally rather than per branch. The save loop carries `uncertain`, which starts from the person's existing doubt and is set by any unknown attempt. While uncertain, only a 200 or a 412 showing our value settles the save. Removing auto-retry was considered and rejected: a manual re-save has the same flaw.
- The 200 and 412 paths now share one confirm helper, which closes the auditor's S4 gap (their ordering against loads diverging) by construction.
- Also: a "saved again elsewhere" message when only the version moved; `If-Match` parsed as in HTTP, with an empty tag refused; doc qualifier: the no-overwrite guarantee holds for the grid, and a PATCH without If-Match is unconditional by design.

## Review round 8 → the doubt becomes data

- Round 7's rule held within a save, but doubt carried over from an earlier save was a guess, and it produced false messages. A manager's own earlier save of 24h (stored, answers lost) was announced as "someone else changed… replace theirs".
- Under If-Match a doubtful save can only ever land while the row is at the version it carried. So the doubt is a concrete pair (version, value), and any observation of the row resolves it: a load or 412 at another version means that save can no longer land, and what's shown is the truth. The "?" clears itself.
- Messages state what the server holds and, when it's known, whose save it was ("your earlier save of 24h went through after all"). They never say "someone else".
- The auditor found the API's returned versions were never checked against the real `xmin`. A wrong 412 version would make every re-save fail forever, with all suites green. Now asserted, together with the cause: a re-save on the 412's version lands, in Go and end to end.
- A sweep for tests that write person 3 without restoring it found four (the R1-X1 lesson, applied systematically rather than to the lines that were reported).
