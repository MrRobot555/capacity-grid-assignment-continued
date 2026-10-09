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
| R1-A1 | 1 | High | After a save that couldn't be confirmed (but was stored), re-entering the old value hit the "unchanged" shortcut: no PATCH, the editor closed, the grid showed 40 while the DB held 50 | RESOLVED | reviewer probe7 |
| R1-A2 | 1 | Medium | Typing a date into From/To lands on a wrong date: the snapped Monday is written back into the segments while typing (03/02/2026 → 2024-12-02, 5 requests) | RESOLVED | probe6/9 |
| R1-A3 | 1 | Medium | Editor `autoFocus` re-fires when its row remounts (search, scroll back): steals focus, jumps scroll. A failed save whose row is off-screen or filtered out shows no error at all | RESOLVED | probe1/3/8 |
| R1-A4 | 1 | Medium | A save that never answers locks all editing until reload (no client timeout, Cancel disabled; no DB timeout either, reproduced with a row lock) | RESOLVED | probe5, FOR UPDATE + curl |
| R1-A5 | 1 | Medium | "Still loading" doesn't reset for a load of the same range (Retry, A→B→A): shows "slow" immediately | RESOLVED | probe4 |
| R1-A6 | 1 | Low | Focus is lost to BODY when the editor closes; Escape does nothing once focus is on the editor's buttons | RESOLVED | probe1 |
| R1-A7 | 1 | Low | "1 weeks" in the Show select for a one-week range | RESOLVED | code path |
| R1-A8 | 1 | Low | Status uses exact values, display rounds to 2 dp: capacity 39.999 vs 40 shows a red "40 +0" | RESOLVED | code path |
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
| R1-X1 | 1 | Low | One run of the 25 browser tests reported 24 passed, the next 25 passed. A flaky test, not yet identified | OPEN | found while verifying the round-1 fixes; out of time |

**Round 1 status:** all 21 findings fixed. Each fix has a test that fails on the pre-fix code (checked by swapping the old source back in), except the coverage-only gaps (G1 404, G5, G6, G11, filter), which pin behaviour that was already right. Go 9, Vitest 60 and Playwright 25 pass, and the build passes. **The cycle is not closed:** round 2 (a re-review of these fixes) was not run, and R1-X1 is open.

## Follow-ups (out of scope)

| ID | Finding | Why out of scope |
|----|---------|------------------|
