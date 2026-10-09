# Review register

Check-fix cycles on the finished submission. Every finding gets a verdict here.
A finding marked RESOLVED, REJECTED or FOLLOWUP is not re-opened unless there is
new evidence that the fix doesn't hold. That rule is what stops fixes going round
in circles.

**Scope (frozen before round 1):** `api/*.go` (handlers, query, tests), `web/src/*`,
and `e2e/*`.
Out of scope and never edited: `db/`, `docker-compose.yml`, the Dockerfiles and the
`Makefile` (the run environment is fixed), and `DECISIONS.md` (the owner's text).
Real bugs found outside scope are listed under follow-ups.

**Severity:**
- **High:** wrong numbers, or lost or false user data.
- **Medium:** a user-visible malfunction.
- **Low:** code quality, coverage or comments.

The goal is zero findings of any severity. Only High and Medium findings open a
new round; Low findings are fixed within the round that found them.

**A cycle closes** when a review round returns zero findings. The reviewers are told
not to invent findings to avoid saying "converged".

**Verdicts:** RESOLVED (fixed; the fix is checked by grepping the whole artifact, not
just the reported line), REJECTED (with a reason), FOLLOWUP (real, but out of scope).

| ID | Round | Severity | Finding | Verdict | Evidence / commit |
|----|-------|----------|---------|---------|-------------------|
| R1-A1 | 1 | High | After a save that couldn't be confirmed (but was stored), re-entering the old value hit the "unchanged" shortcut: no PATCH, the editor closed, the grid showed 40 while the DB held 50 | RESOLVED (reopened by R2-A1, R2-A2 , redesigned in round 2) | reviewer probe7 |
| R1-A2 | 1 | Medium | Typing a date into From/To lands on a wrong date: the snapped Monday is written back into the segments while typing (03/02/2026 → 2024-12-02, 5 requests) | RESOLVED | probe6/9 |
| R1-A3 | 1 | Medium | Editor `autoFocus` re-fires when its row remounts (search, scroll back): steals focus, jumps scroll. A failed save whose row is off-screen or filtered out shows no error at all | RESOLVED (reopened by R2-A3 , redesigned in round 2) | probe1/3/8 |
| R1-A4 | 1 | Medium | A save that never answers locks all editing until reload (no client timeout, Cancel disabled; no DB timeout either, reproduced with a row lock) | RESOLVED | probe5, FOR UPDATE + curl |
| R1-A5 | 1 | Medium | "Still loading" doesn't reset for a load of the same range (Retry, A→B→A): shows "slow" immediately | RESOLVED | probe4 |
| R1-A6 | 1 | Low | Focus is lost to BODY when the editor closes; Escape does nothing once focus is on the editor's buttons | RESOLVED (reopened by R2-A5, R2-A8 , redesigned in round 2) | probe1 |
| R1-A7 | 1 | Low | "1 weeks" in the Show select for a one-week range | RESOLVED | code path |
| R1-A8 | 1 | Low | Status uses exact values, display rounds to 2 dp: capacity 39.999 vs 40 shows a red "40 +0" | RESOLVED (reopened by R2-A7 , redesigned in round 2) | code path |
| R1-A9 | 1 | Low | 500s are not logged; the DB error is discarded | RESOLVED | capacity.go, people.go |
| R1-A10 | 1 | Low | Year 0000 is accepted and returns week "-0001-12-27" (not YYYY-MM-DD) | RESOLVED | curl |
| R1-G1 | 1 | High | Save-failure honesty only gated for 500 and no-answer: a 4xx save and a 502/503/504 save are untested (mutations C3, C4, A2 survive every suite) | RESOLVED | mutation log |
| R1-G2 | 1 | Medium | Virtualisation e2e runs at the default font where the 44px guess is already right, so it never exercises the measurement (R1, R3 survive) | RESOLVED | 17px probe |
| R1-G3 | 1 | Medium | Previous week, This week, From/To, Show and "Only over capacity" have no gate (C8–C14 survive) | RESOLVED | mutation log |
| R1-G4 | 1 | Medium | URL clamp to 106 weeks and invalid-URL fallback are untested (URL1–3 survive) | RESOLVED | mutation log |
| R1-G5 | 1 | Medium | Cancel/Esc disabled and input read-only during a save are untested (C6, C7 survive) | RESOLVED | mutation log |
| R1-G6 | 1 | Low | No reducer test that a stale `fetchFailed` is dropped (S4; with U1 survives every suite) | RESOLVED | mutation log |
| R1-G7 | 1 | Low | `toBe(MAX_WEEKS)` compares the constant with itself; nothing ties it to the API's 106 (D2 survives) | RESOLVED | dates.test.ts |
| R1-G8 | 1 | Low | TestUpdatePerson never reads the row back from the DB (P5 survives Go) | RESOLVED | api_test.go |
| R1-G9 | 1 | Low | No Go test with a Sunday `from` (G10 survives) | RESOLVED | api_test.go |
| R1-G10 | 1 | Low | Save test mock echoes the typed value, so "grid uses the server's value" is not distinguished (U4 survives) | RESOLVED | CapacityGrid.test.tsx |
| R1-G11 | 1 | Low | Untested: unchanged value sends no PATCH, summary hidden while an old range is shown, first-load skeleton (C15, C18, C19) | RESOLVED | mutation log |
| R1-X1 | 1 | **High** (was Low) | The "flaky" browser test was a real bug. The API's save timeout was a Go context deadline, which only stops Go waiting: an UPDATE queued behind a row lock still committed once the lock was released, after the API had answered 503 "Not saved". The Go locked-row test therefore sometimes left Cem at 21, and the browser suite, run right after it, failed its "Cem starts at 20" check | RESOLVED | Reproduced 2/3 by waiting 500 ms after releasing the lock. Fix: the limit is now Postgres's own `statement_timeout`, inside a transaction, so a timeout aborts the transaction. 5/5 green, and Go then e2e twice: 26/26 |

| R1-C1 | 1 | Low | My own caveats from round 1, now closed. The 17px row test is shown to fail without the row measurement. A test checks the save timeout is 15 s, not just that a timer exists. A browser test covers scrolling back to an open editor (focus is not taken). Go tests check that 500s and timeouts are logged. Each fails on the pre-round-1 code | RESOLVED | post-submission branch |
| R2-A1 | 2 | High | (reopens R1-A1) The "outcome unknown" flag lived in the editor, so opening another person's editor dropped it without a reload: grid 40h, DB 50, and re-entering 40 sent nothing | RESOLVED | adversarial probe1 |
| R2-A2 | 2 | High | (reopens R1-A1; both reviewers) A later definite failure overwrote "outcome unknown": lost save, then a JSON 500 on retry. Cancel doesn't reload and 40 isn't re-sent | RESOLVED | probe2; auditor's Vitest probe |
| R2-A3 | 2 | Medium | (reopens R1-A3) The off-screen banner checks "rendered", not "visible": a row in the overscan band counts as shown, so the error sits out of sight | RESOLVED | probe3 + screenshot |
| R2-A4 | 2 | Medium | The off-screen banner says "weren't saved" even when the outcome is unknown, contradicting DECISIONS.md | RESOLVED | probe4 |
| R2-A5 | 2 | Medium | (reopens R1-A6) After a slow save, focus jumps back to the capacity button even if the manager moved on: typing is lost, and Space reopens the editor | RESOLVED | probe5 |
| R2-A6 | 2 | Medium | A failed COMMIT (connection drop) is an unknown outcome, but the API answers with its JSON 500, which the client reads as a definite "Not saved" | RESOLVED | scratch TCP-proxy Go test: 500 while the DB held 33 |
| R2-A7 | 2 | Low | (reopens R1-A8) Status rounds with Math.round(x*100), display with toFixed(2): half-cent values disagree (157 cases in 0–168) | RESOLVED | status.mjs |
| R2-A8 | 2 | Low | (reopens R1-A6) When the saved row leaves the filtered list, focus falls to BODY | RESOLVED | probe6 |
| R2-G1 | 2 | Medium | Failed save with its row scrolled out of the window, and "Show" scrolling to it, are untested (jsdom renders every row) | RESOLVED | B2, B4 survive; probe P-B |
| R2-G2 | 2 | Medium | "Show" clearing "Only over capacity" is untested | RESOLVED | B3 survives |
| R2-G3 | 2 | Medium | The half-typed-year gate types inside the 600 ms pause, so it never sees one; removing isSupportedDate survives | RESOLVED | D3 survives; probe P-D3 |
| R2-G4 | 2 | Medium | The 106-week cap on ranges changed in the UI (not the URL) is untested | RESOLVED | X4 survives |
| R2-G5 | 2 | Medium | The date field keeping the typed date after blur (not following the range) is untested | RESOLVED | D4 survives |
| R2-G6 | 2 | Low | Commit-on-Enter and commit-on-blur aren't measured (the 600 ms pause commits anyway) | RESOLVED | D5, D6 survive |
| R2-G7 | 2 | Low | Only an HTML 502 is tested; classifying non-JSON errors by status survives | RESOLVED | W3b survives |
| R2-G8 | 2 | Low | Focus return after a successful save is untested | RESOLVED | F4 survives |
| R2-G9 | 2 | Low | "1 weeks" in the summary line is untested (only the select is) | RESOLVED | X3 survives |
| R2-G10 | 2 | Low | The PATCH 500 log and the API accepting exactly 168 are untested | RESOLVED | G1, G7 survive |

**Round 1 status:** all 21 findings fixed. Each fix has a test that fails on the pre-fix code (checked by swapping the old source back in), except the coverage-only gaps (G1 404, G5, G6, G11, filter), which pin behaviour that was already right. Go 9, Vitest 60 and Playwright 25 pass, and the build passes. **The cycle is not closed:** round 2 (a re-review of these fixes) is next. (R1-X1 has since been found and fixed on the local `post-submission` branch.)

| R3-A1 | 3 | High | (new evidence against R2-A1/A2) The redesign assumed a load issued after an unknown outcome proves the server's value. Behind a proxy that answers without cancelling, the reload reads 40 and clears "?", then the queued save commits 50: grid 40h with no marker, and re-entering 40 sends nothing. Also: `Begin` (waiting for a pooled connection) had no time limit | RESOLVED | adversarial p1/p1b (needs such a proxy; Vite cancels) |
| R3-A2 | 3 | Medium | The editor panel says "(now 40h)" unqualified while the outcome is unknown; after typing or reopening nothing warns | RESOLVED | p2 |
| R3-A3 | 3 | Low | Pressing Save disables the focused button, so focus falls to BODY; after a failure Escape does nothing | RESOLVED | p3 |
| R3-A4 | 3 | Low | The "?" tooltip says "reloading to check" even after the reload has failed | RESOLVED | code path |
| R3-G1 | 3 | High | The timeout test only checks "didn't answer within 15 seconds", text present in both messages; a timeout classed as definite (M3) survives every suite | RESOLVED | M3 |
| R3-G2 | 3 | High | TestCommitOutcome tests the helper, not the wiring: never calling it (G1), dropping the handler branch (G2, G6) or the `stored` field (G3) all survive | RESOLVED | G1–G3, G6 |
| R3-G3 | 3 | High | Nothing checks `unconfirmedAt` is per person: replacing the map (R6) wipes another person's doubt and survives every suite | RESOLVED | R6 |
| R3-G4 | 3 | Medium | A failed save leaving focus where the manager moved it is untested (F1 survives) | RESOLVED | F1 |
| R3-G5 | 3 | Medium | Switching person (Dee's panel open, click Ana) moving focus into Ana's input is untested (F2 survives) | RESOLVED | F2 (e2e only) |
| R3-G6 | 3 | Medium | A save in flight surviving a range change is untested (P4 survives) | RESOLVED | P4 |
| R3-G7 | 3 | Low | "reloads at once" clicks Ana before checking, so reloading only when an editor opens passes (U2) | RESOLVED | U2 |
| R3-G8 | 3 | Low | The panel's "(now Xh)" is never asserted (P1) | RESOLVED | P1 |
| R3-G9 | 3 | Low | Own capacity button disabled while editing is untested (P2) | RESOLVED | P2 |
| R3-G10 | 3 | Low | The accessible name ", last save not confirmed" is untested (M8) | RESOLVED | M8 |
| R4-A1 | 4 | High | (new evidence against R3-A1) The doubt lives only in the page's memory: F5 or a second tab shows the value without "?" (the R3-A1 end state). The doubt is also recorded only when the save fails, not when it starts | RESOLVED by owner decision: **server-side fix**. A Save-Id outcome registry with fencing; `pg_xact_status` for lost COMMIT answers; a `saving` flag in capacity for every client and tab; the client asks until it gets a definite answer, and blocks a second save of that person meanwhile | adversarial p2 |
| R4-A2 | 4 | Low | (round-3 regression) While unconfirmed, the doubt note replaces the "Changes capacity for every week, past and future" warning that DECISIONS.md promises | RESOLVED | p1 |
| R4-A3 | 4 | Low | `capacityView` claims "every place that shows a capacity" uses it, but the summary and the week headers' over-counts use the doubtful value without saying so | RESOLVED | p1 |
| R4-A4 | 4 | Low | (relocation, both reviewers) Comments still state the old premise ("reloads to check", "so the reload can't settle it"), in CapacityGrid.tsx and saving.test.tsx | RESOLVED | grep |
| R4-A5 | 4 | Low | (relocation) `unconfirmedAt` timestamps are dead data, a leftover of the load filter round 3 removed | RESOLVED | code path |
| R4-G1 | 4 | High | No gate that a confirmed save of one person leaves another's doubt alone, the round-3 premise itself (V1 survives every suite) | RESOLVED | V1 + grid probe |
| R4-G2 | 4 | High | The whole-save deadline has no gate: not its existence (G1), its order against the client's 15 s (G3), or its reach into COMMIT (G5) | RESOLVED | G1, G3, G5 survive; pool probe |
| R4-G3 | 4 | Low | Tooltip wiring of `capacityView` (button title, cell title) is unchecked (V2, V3) | RESOLVED | |
| R4-G4 | 4 | Low | Clicking "Saving…" again is stopped only by `submit`'s guard (aria-disabled lets the click through); removing the guard survives (V4) | RESOLVED | |
| R5-A1 | 5 | High | `crypto.randomUUID` exists only in secure contexts: over plain HTTP on a LAN address (Compose serves on 0.0.0.0) saving hangs at "Saving…" forever, with no request sent | RESOLVED: the id now comes from `crypto.getRandomValues`, which needs no secure context, and the submit has a catch that always ends the save. Gated: "saves without crypto.randomUUID", "ends the save with a message if something throws" | probe5 |
| R5-A2 | 5 | High | A lookup's "stored" answer is an old snapshot applied as fresh: the grid showed 50h, confirmed, while the DB held 30 (another manager's later save) | RESOLVED BY REDESIGN: a definite answer to a repeat is never applied as the new value; the range reloads. Gated: "never applies a repeat answer as the new value" (the server changed to 30 meanwhile; the grid shows 30) | probe3 |
| R5-A3 | 5 | High | With loads slower than 2 s, the in-progress refresh aborts itself for ever: "?" and a disabled button that never clear | REMOVED BY REDESIGN: the `saving` flag and its polling no longer exist | probe1 |
| R5-A4 | 5 | Medium | A fence lives in process memory: after an API restart a late request with a fenced Save-Id is stored, contradicting a "Not saved" already shown | REMOVED BY REDESIGN: there is no fence and no lookup. A refused save is remembered by id, so a late duplicate is refused. A restart loses that memory, which is documented in saves.go | scratch Go test |
| R5-A5 | 5 | Medium | A lookup has no timeout: one hung lookup keeps the person "checking" for ever; the 30-attempt cap never applies | REMOVED BY REDESIGN: there are no lookups. Each repeat is a PATCH with its own 15 s timeout, up to 5 attempts | probe2 |
| R5-A6..A10 | 5 | Low | `confirm` keeps a stale `saving` flag (a false note and focus to BODY); `saving()` read after the query; replay ignores person and value; timeout comments overclaim (a save can take ~17 s); the doc says "3,111 run into a weekend" (3,111 *end* on one) | RESOLVED or REMOVED: the stale `saving` flag, `saving()` and the timeout overclaim are gone with the redesign; replay now refuses another person or value with 422 (gated); the doc says "6,883 of 8,413 span a weekend (3,111 end on one)", re-measured | probes 4, code paths, psql |
| R5-G1 | 5 | High | The `pg_xact_status` "aborted" and "in progress" branches are ungated: mutated, the API answered 200 "33" while the DB held 20 | REMOVED BY REDESIGN: no `pg_xact_status`. A lost COMMIT is reported `stored: unknown` and the repeat settles it, gated in 3 proxy modes including "COMMIT never delivered" | G1, G2 + drop-COMMIT probe |
| R5-G2 | 5 | High | How a lost COMMIT is recorded in the registry is ungated (the proxy test sends no Save-Id): the lookup said "not-stored" while the DB held 33 | RESOLVED: the proxy test sends a Save-Id and checks that the repeat settles it with a definite 200 and the value stored | G3 |
| R5-G3..G7 | 5 | Medium | Ungated: the in-progress lookup path, the 30-attempt cap and the final "unknown", the quiet refresh in the real grid, submit while another client is saving, and the `saving` field name across Go and the browser | REMOVED BY REDESIGN (lookups, cap, quiet refresh, saving flag, field name all gone); the retry cap is gated ("gives up after 5 attempts") | W1–W5, G4, G7 |
| R5-G8..G13 | 5 | Low | Ungated: HTTP timeout ordering, duplicate and concurrent replay, pruning, instance edge cases, summary and aria-disabled states; two comments describe "unknown" wrongly | RESOLVED or REMOVED: replay and concurrent repeats are gated (TestRepeatWhileInProgressDoesNotRunTwice), pruning is gated (TestFinishedSavesAreForgottenAfterAWhile), instance handling is gone, the summary and aria-disabled states are gated, and the comments are rewritten | G5, G6, G9, G10, W7, W9, W11 |
| R6-A1 | 6 | Medium | (R3-A4 pattern) The `settled` state shows "Sending it again" after a repeat got a definite answer; if the reload fails the false note stays | REMOVED BY REDESIGN: the `settled` state no longer exists. A 412 carries the current row, which is applied directly, so no reload follows | adversarial p1 |
| R6-A2 | 6 | Medium | (new evidence against R4-A1) A late copy of a given-up save, with an id the API never saw, runs and overwrites a later confirmed save | RESOLVED BY REDESIGN: a late copy carries the version its sender saw, and any change since makes it a 412. Gated: TestLateCopyCannotOverwriteANewerChange | p2 (person 8: 28 confirmed, then the late 26 stored) |
| R6-A3 | 6 | Medium | "Running a save twice is harmless" is false: a repeat after an unknown outcome overwrites another manager's change made in between (a regression from round 4) | RESOLVED BY REDESIGN: a repeat after someone else's change gets 412 and never overwrites it. Gated: TestSaveOnAStaleVersionIsRefused; Vitest "does not let a repeat overwrite a change made in between"; e2e "a save on a stale view doesn't overwrite another manager's change" | scratch TestR6RerunOverwritesNewerChange |
| R6-A4 | 6 | Medium | A restart loses more than the refused guard: a repeat of a stored save runs again over a newer change, and a failed rerun says "Not saved" while the first attempt stored | REMOVED BY REDESIGN: there is no in-memory registry to lose. The version lives in the row, so a restart changes nothing | scratch tests |
| R6-A5..A6 | 6 | Low | Ungated: a repeat refused for certain (settle and reload); an unknown record marked in progress on rerun | REMOVED BY REDESIGN (the settle and rerun branches are gone) | mutants survive |
| R6-G1 | 6 | High | The registry state after a failed rerun is ungated: recorded as `refused`, the next repeat says "Not saved" | REMOVED BY REDESIGN (no registry state). The lost-COMMIT gate now asserts the repeat's answer, 200 or 412 showing our value, in 3 modes | G1 survives |
| R6-G2 | 6 | Medium | The backoff schedule (1/2/4/8 s) and the 5-attempt count are ungated: no delay passes every suite | RESOLVED: "waits 1, 2, 4 and 8 seconds between the 5 attempts" uses fake timers and the real schedule | W1, W2, W4, W5 survive |
| R6-G3..G8 | 6 | Medium/Low | Refused-repeat branch, the e2e "answered from the record" claim (a rerun passes it too), `keep` vs the retry window, rerun recording, refused-replay body, the `settled` note, the restart comment | REMOVED BY REDESIGN or RESOLVED: the refused-repeat, record, keep, rerun, replay and settled gaps went with their mechanisms; the e2e lost-answer test now asserts the real API answered the repeat 412 ([200, 412]) | G2, G3, G5, G11, W3, W7, the F4 mutant |
| R7-A1 | 7 | High | (both reviewers; new evidence against R6-A4 and R2-A2) After an attempt with an unknown outcome, a definite answer to the *repeat* was reported as the save's fate. A definite failure said "Not saved" (the DB held 50) and left "?" with "Sending it again" stuck; a 412 showing another manager's later value said "Not saved" although our attempt had landed first | RESOLVED (structural): the outcome belongs to the save. `uncertain` starts from the person's doubt and is set by any unknown attempt; then a definite failure means unconfirmed (saveGaveUp, so "?" says "may hold a different value", never "Sending it again"), and a 412 with another value says "your earlier attempt may have been stored before that". Gated by 3 Vitest tests that fail on the pre-fix code | adversarial probe.mjs (real API, person 12); auditor probe P1 |
| R7-A2 | 7 | Low | A 412 says the hours "were changed" when only the version moved (someone re-saved the same value) | RESOLVED: a 412 whose value equals what this view loaded says "someone else saved these weekly hours meanwhile (still Xh)". Gated | code path, live version-only bump |
| R7-A3 | 7 | Low | `If-Match` parsing: `*` never matches; `""` is treated as unconditional (an empty client version would silently fall back to last-write-wins) | RESOLVED: `parseIfMatch` follows HTTP (`*` = any row, weak tags allowed) and refuses an empty tag with 400. Gated: TestIfMatchIsReadAsInHTTP, TestUnknownPersonIsNotFoundWithIfMatch | live |
| R7-G1 | 7 | Medium | No test that a load refreshes a known person's version (K2 survives): after a reload, the next save would get a false "changed on the server" | RESOLVED: a reducer test that a later load refreshes a known person's version (kills K2) | K2 |
| R7-G2 | 7 | Medium | The keepLocal test asserts only the hours, not the version (K1); the 412 path's ordering against loads is ungated (S4) | RESOLVED: the keepLocal test asserts the whole row, version included (kills K1). S4 is removed structurally: the 200 and 412 paths share one `confirmWith`, so their ordering can't diverge | K1, S4 |
| R7-G3 | 7 | Low | 404 through If-Match (the client's path) is untested (G1) | RESOLVED: TestUnknownPersonIsNotFoundWithIfMatch | G1 |
| R8-A1 | 8 | High | Doubt carried from an earlier save gives false messages: after a given-up save of 24 (stored), saving 20 says "*someone else* changed… replace theirs" (it was our own 24); with prior doubt, a definite refusal of 26 says "may or may not hold it"; within a save, a version-only 412 still says "changed" | RESOLVED (structural): doubt is the (version, value) of the doubtful save. Messages never attribute a change; "your earlier save of 24h went through after all"; a definite refusal says "Not saved" plus "your earlier save of Xh is still unconfirmed"; a version-only change says "saved again since you loaded them". Gated by 3 Vitest tests | real browser + API, person 14 (p1, p2, p3) |
| R8-A2 | 8 | Medium | (both reviewers) Doubt from an earlier save carrying into the next save is ungated: `uncertain = false` passes all 82 Vitest tests | RESOLVED: the earlier-doubt path is gated (a mutant ignoring it fails 2 tests) | V1 |
| R8-A3..A6 | 8 | Low | A stale `SaveResult` comment; TestUnknownPersonIsNotFoundWithIfMatch has no cleanup (person 3); an If-Match *list* is read as one tag; the docs say "six rounds" | RESOLVED: the SaveResult comment is rewritten; every test that writes person 3 restores it (found by a sweep, 4 tests); If-Match lists are parsed (TestIfMatchListMatchesAnyVersion); the docs say eight rounds | code, live probe on person 16 |
| R8-G1 | 8 | High | Response versions are never checked against the row's real `xmin`: a 412 carrying the client's stale version (G-A) makes every re-save fail forever, and a wrong 200 version (G-R) gives false "saved meanwhile"; both pass every suite | RESOLVED: the 200 and 412 versions are asserted equal to the row's real xmin, plus the cause: a re-save on the 412's version lands (Go), and the e2e stale-view test re-saves and lands. G-A and G-R are both caught | G-A (mutant API, live), G-R |
| R8-G2..G4 | 8 | Medium | Ungated: the API accepting 0 h (G-B); typing a From date *before* To (E2); measuring the viewport height (VR1: a 346 px blank band at 1280×1800) | RESOLVED: TestUpdatePersonAcceptsZero; e2e "typing a From date before To" (E2 caught); e2e virtualisation in a 1280×1800 window (VR1 caught) | G-B, E2, VR1 |
| R8-G5..G10 | 8 | Low | Ungated presentation (bar `--fill`, current-week class, empty-state texts); a dead mock and comment; a vacuous version test; WriteTimeout ordering unpinned; e2e README says only one test writes to the real API | RESOLVED: Vitest gates for the bar fill, the current-week class and the empty-state texts; the dead mock removed; the version test can no longer pass vacuously; WriteTimeout pinned via newHTTPServer (TestServerTimeoutsOutlastASave); the e2e README corrected | E3, E4, E6 and code |
**Round 2 status:** 18 findings. The two areas that recurred 5 times were redesigned, not patched (see Recurrence). Every finding has a gate, and every gate was checked against the code it guards:
- The new Vitest gates: 8 fail on the pre-redesign code. One gate of mine passed on the old code because it went through the already-fixed path; it was rewritten to take the reported path and now fails there.
- The new e2e editor gates: all 3 fail on the pre-redesign code.
- Mutations D5 and D6, which survived round 2, are now caught.

Go 13, Vitest 66 and Playwright 32 pass, and the build passes. My own test mistake this round: the date tests assumed one Tab leaves a date input, but Chrome's first Tab lands on the field's calendar button. The tests now blur explicitly. **Next: round 3 (re-review).**

**Round 3 status:** 14 findings. The save-outcome area recurred 3 times *after* its round-2 redesign, so it was redesigned again:
- **New premise:** only a confirmed save of that person clears doubt. A load updates the value shown but not the doubt.
- **New structure:** one presenter, `capacityView`, for every place a capacity is shown.
- **API:** one deadline for the whole save; error mapping in one tested function; a permanent TCP-proxy test that cuts the answer after COMMIT.

Gate checks: 9 Vitest mutations from the audit (R6, F1, P2, P4, M3, M8, P1, U2, plus "loads clear the doubt") and 2 browser ones (F2, Save focus) are now caught. G1 (commitOutcome unwired) fails the proxy test with an explicit message. Go 15, Vitest 73 and Playwright 34 pass, and the build passes. **Next: round 4.**

**Round 4 status:** 9 findings. R4-A1 was closed server-side, by the owner's decision: outcomes became answerable by the API instead of guessed by one tab. Also fixed: the editor shows the warning and the doubt together; the summary counts unconfirmed capacities; stale comments and dead timestamps removed; the health check no longer leaks database errors; the server has HTTP timeouts.

Gate checks:
- 6 Go mutations caught: no fencing, fencing across processes, no `saving` flag, no `pg_xact_status`, no whole-save deadline, no replay.
- 7 web mutations caught: confirm wipes every doubt, no lookup, not blocked while checking, `saving` ignored, no refresh, loads clear doubt, the editor ignores the answer.
- One gate (the whole-save deadline) was caught but failed slowly: a 120 s hang in cleanup. It now fails in seconds.

Go 25, Vitest 78 and Playwright 35 pass. **Next: round 5.**

**Round 5 status:** 23 findings, with the count *rising*. This prompted the correction to how recurrences are counted (see Recurrence), and the owner's decision to **redesign by subtraction**:
- **Removed:** the lookup endpoint, fencing, instance ids, `pg_xact_status`, and the `saving` flag with its polling.
- **Kept:** idempotent repeats with the same `Save-Id`. The API recognises a repeat: stored → answered from the record; refused → refused again; unknown → run again. The client never applies a repeat's answer as the new value; it reloads instead.

Gate checks: 5 Go mutations (no replay, refusals not remembered, rerun-after-unknown saying "not stored", id reuse, a repeat running twice) and 5 web mutations (the repeat's answer applied, no repeat, a new id per attempt, `crypto.randomUUID`, no catch) are all caught. Go 25, Vitest 77 and Playwright 35 pass. **Next: round 6.**

**Round 6 status:** 13 findings. All of them traced to one root: without a row version, the API couldn't tell a repeat of an old change from a current one. By the owner's decision, the save path was **redesigned by subtraction** around Postgres's `xmin` as the row version (no schema change), sent back as `If-Match`; a stale save gets 412 with the current row. Deleted: the Save-Id registry, the replay rules and the `settled` state. As a by-product, two managers editing at once can no longer silently overwrite each other.

Gate checks: 4 Go mutations (If-Match ignored, 412 without the row, no version in capacity, the old version returned) and 4 web mutations (no If-Match, a 412 counted as saved, the 412's row not applied, a stale version reused) are all caught. Two of my Go gates panicked on nil and stopped the rest of the run; they now fail cleanly. Go 21, Vitest 78 and Playwright 36 pass. **Next: round 7.**

**Round 7 status:** 6 findings, and the count is falling again (23, 13, 6). The `xmin` design held up under every attack. The High, found by both reviewers independently, was the client reading a request's answer as the save's fate. It was fixed structurally with one rule in one place. Gates: 4 new save tests fail on the pre-fix code; K1 and K2 are killed; S4 is removed by construction. **Next: round 8.**

**Round 8 status:** 14 findings (2 High). The save-outcome area recurred, so the doubt became data, the (version, value) of the doubtful save, resolved by any observation of the row. All 5 surviving mutants from the audit (G-A, G-R, the earlier doubt ignored, E2, VR1) are now caught. Go, Vitest 88 and Playwright 38 pass. **Next: round 9.**

## Recurrence (standing rule: a 3rd recurrence in one area means redesign, not another patch)

Counted per area across the whole register, including occurrences from before the rule.

**Correction (round 5, owner's question "do you follow the rule?").** I had been resetting the count after each redesign. The owner's rule counts every occurrence in the register. Counted that way, the save-outcome area has come back about 12 times across 5 rounds and 3 redesigns. Each of those redesigns was *additive*: the same approach (track the doubt, then reconcile it), with more machinery each time. That machinery produced the next round's findings, so the counts went 23, 18, 14, 9, then 23 again. A redesign that recurs must **subtract**, not add.

| Area | Occurrences | Count | Action |
|------|-------------|-------|--------|
| The UI asserting a save outcome it doesn't know | R1-A1, R2-A1, R2-A2, R2-A4, R2-A6 | 5 | **REDESIGN (round 2):** "outcome unknown" moves from the editor into the reducer, per person. Only a confirmed save, or a load issued after the uncertainty began, clears it. The range reloads the moment an outcome is unknown. One function (`isDefiniteFailure`) decides every message. The API reports a lost COMMIT as `stored: unknown` |
| The editor living inside a virtualised, filterable row (focus, visibility of its error) | R1-A3, R1-A6, R2-A3, R2-A5, R2-A8 | 5 | **REDESIGN (round 2):** the editor leaves the rows and becomes one panel docked above the grid, so scrolling or filtering can't unmount it, re-focus it or hide its error. The off-screen banner, "Show" and visibility detection are removed. Focus moves only on the user's own actions, and comes back to the row's button only if it was still in the editor |
| ↳ same area, since the round-2 redesign | R3-A1, R3-A2, R3-A4 | 3 | **REDESIGN AGAIN (round 3).** The premise was wrong ("a later load proves the value"), and certainty was decided separately at each place a capacity is shown. New premise: only a confirmed save of *that person* clears doubt; loads update the value shown but never the doubt. New structure: one presenter (`capacityView`) gives the text, marker and explanation to every place a capacity appears. API: one deadline for the whole save, Begin through Commit |
| ↳ save-outcome area, since the round-3 redesign | R4-A1, R4-A3 | 2 | below the threshold, but **the owner chose a server-side redesign for R4-A1**: outcomes become answerable by the server instead of guessed by one tab |
| **save-outcome area, all rounds** | R1-A1, R2-A1, R2-A2, R2-A4, R2-A6, R3-A1, R3-A2, R3-A4, R4-A1, R4-A3, R5-A1..A5, R5-G1..G7 | ~12 areas of recurrence | **REDESIGN BY SUBTRACTION (round 5, owner's decision).** A save sets an absolute value, so it is idempotent. On an unknown outcome the client re-sends the *identical* request (same Save-Id) until it gets a definite answer, then reloads; it never applies an old payload as fresh. The server keeps only replay by id. Deleted: the lookup endpoint, fencing, instance ids, `pg_xact_status`, and the `saving` flag with its polling. Accepted limitation: other tabs and managers don't see "?" during the seconds of retrying, the same staleness as two managers editing at once (SCAFFOLD-FINDINGS §5) |
| **save-outcome area, round 6** | R6-A1..A4, R6-G1, R6-G3..G8 | the area recurred again | **REDESIGN BY SUBTRACTION (round 6, owner's decision).** The remaining defects had one root: the API couldn't tell a repeat of an old change from a current one, because a row has no version (SCAFFOLD-FINDINGS §5). Postgres's `xmin` system column changes on every update of a row, which makes it a version with no schema change. GET returns each person's `version`; PATCH sends `If-Match`, and the UPDATE applies only if the row is unchanged, otherwise 412 with the current row. Deleted: the Save-Id registry, replay rules and the `settled` state. A lost answer is settled by repeating with the same `If-Match`: 200 (it never landed) or 412 (it, or someone else, changed the row; the current row says which) |
| **save-outcome area, round 7** | R7-A1 (both reviewers) | the area recurred again | **STRUCTURAL FIX, one rule in one place:** an outcome belongs to the *save*, not to a request. Once any attempt (or an earlier save of that person) is unknown, only a 200, or a 412 showing our value, settles it. A later definite failure means still unknown; a 412 with another value means "changed elsewhere; your earlier attempt may have landed first". The 200 and 412 paths share one confirm helper, so their ordering against loads can't diverge. Removing auto-retry was considered and rejected: a manual re-save has the identical flaw, so it wouldn't remove the root |
| **save-outcome area, round 8** | R8-A1, R8-A2 | the area recurred again | **STRUCTURAL: doubt becomes data.** `unsure[id]` holds the (version, value) the doubtful save carried. Any load or 412 showing another version resolves it (under If-Match, that save can no longer land, and what is shown is the truth), so the "?" clears itself. Messages state what the server holds and which of our saves it was when known ("your earlier save of 24h went through after all"); they never attribute a change to "someone else". This replaces round 7's guess that doubt carries from the person's earlier save |
| ↳ editor area, since the round-2 redesign | R3-A3 | 1 | patch |
| Status vs displayed value rounding | R1-A8, R2-A7 | 2 | patch: one `hundredths()` used by status, overage and text |
| Typing into date fields | R1-A2 | 1 | patch |
| Server errors not logged | R1-A9 | 1 | patch |
| Leftover state between test runs | R1-X1 | 1 | patch |

## Follow-ups (out of scope)

| ID | Finding | Why out of scope |
|----|---------|------------------|
