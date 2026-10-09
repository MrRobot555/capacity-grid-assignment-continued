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

## Recurrence (standing rule: a 3rd recurrence in one area means redesign, not another patch)

Counted per area across the whole register, including occurrences from before the rule. After a redesign, occurrences are counted again from zero, so the redesign itself is held to the same rule.

| Area | Occurrences | Count | Action |
|------|-------------|-------|--------|
| The UI asserting a save outcome it doesn't know | R1-A1, R2-A1, R2-A2, R2-A4, R2-A6 | 5 | **REDESIGN (round 2):** "outcome unknown" moves from the editor into the reducer, per person. Only a confirmed save, or a load issued after the uncertainty began, clears it. The range reloads the moment an outcome is unknown. One function (`isDefiniteFailure`) decides every message. The API reports a lost COMMIT as `stored: unknown` |
| The editor living inside a virtualised, filterable row (focus, visibility of its error) | R1-A3, R1-A6, R2-A3, R2-A5, R2-A8 | 5 | **REDESIGN (round 2):** the editor leaves the rows and becomes one panel docked above the grid, so scrolling or filtering can't unmount it, re-focus it or hide its error. The off-screen banner, "Show" and visibility detection are removed. Focus moves only on the user's own actions, and comes back to the row's button only if it was still in the editor |
| ↳ same area, since the round-2 redesign | R3-A1, R3-A2, R3-A4 | 3 | **REDESIGN AGAIN (round 3).** The premise was wrong ("a later load proves the value"), and certainty was decided separately at each place a capacity is shown. New premise: only a confirmed save of *that person* clears doubt; loads update the value shown but never the doubt. New structure: one presenter (`capacityView`) gives the text, marker and explanation to every place a capacity appears. API: one deadline for the whole save, Begin through Commit |
| ↳ editor area, since the round-2 redesign | R3-A3 | 1 | patch |
| Status vs displayed value rounding | R1-A8, R2-A7 | 2 | patch: one `hundredths()` used by status, overage and text |
| Typing into date fields | R1-A2 | 1 | patch |
| Server errors not logged | R1-A9 | 1 | patch |
| Leftover state between test runs | R1-X1 | 1 | patch |

## Follow-ups (out of scope)

| ID | Finding | Why out of scope |
|----|---------|------------------|
