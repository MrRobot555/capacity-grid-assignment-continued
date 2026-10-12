# This repository continues the submitted one

**Submitted:** https://github.com/MrRobot555/capacity-grid-assignment (`main` @ `f772a98`).
That is the assignment as handed in, within the time budget. It has been left
untouched since.

**This repository** starts with an exact snapshot of that state (the first
commit, "Start: the submitted state") and continues from there. Every later
commit is work done after the submission, with its real timestamp, so the
progression can be followed commit by commit.

## What happened after the submission

The submitted code had already been through one review round (21 findings,
fixed in the submission). After that, review continued in rounds, each with two
independent reviewers: one adversarial, reproducing every finding; one auditing
the tests by mutation, planting realistic bugs to see which tests catch them.
Every finding has a verdict in [`.notes/review-register.md`](.notes/review-register.md).

| Round | Findings | What it changed |
|---|---|---|
| 1 | 21 | fixed in the submission |
| — | 1 | a "flaky" test was a real bug: after a timeout, the API said "not saved" while the value could still commit. The limit moved into Postgres (`statement_timeout`) |
| 2 | 18 | two areas had recurred five times each, so they were **redesigned** instead of patched: the save-outcome state, and the editor (moved out of the virtualised rows) |
| 3 | 14 | the save-outcome redesign rested on a false premise ("a later load proves the value"), so it was **redesigned again** |
| 4 | 9 | a **server-side** outcome registry with lookups, fencing, `pg_xact_status` and cross-tab polling |
| 5 | 23 | the count *rose*: every redesign so far had **added** machinery to the same approach. Recounting per the rule (every occurrence counts, no reset after a redesign), the area had recurred about 12 times, so it was **redesigned by subtraction**. A save is idempotent, so a lost answer is settled by sending the identical request again (same `Save-Id`), and the API recognises the repeat. The lookups, fencing, instance ids, `pg_xact_status` and polling were deleted |
| 6 | 13 | the area recurred again, all from one root: with no row version, the API couldn't tell a repeat of an old change from a current one, so a repeat could overwrite another manager's newer change. **Redesigned by subtraction again**: Postgres's `xmin` system column serves as the row version with no schema change; a save sends `If-Match`, and a stale save gets 412 with the current row. The Save-Id registry and its replay rules were deleted. As a by-product, two managers editing at once through the grid can no longer silently overwrite each other |
| 7 | 6 | both reviewers found the client reading a *request's* answer as the *save's* fate (after a lost answer, a refused repeat said "Not saved" although the first attempt had landed). **Structural fix in one place**: an outcome belongs to the save; once any attempt is unknown, only a 200, or a 412 showing our value, settles it. The `xmin` design itself held up under every attack (locks, VACUUM FREEZE/FULL, concurrent transactions, late copies) |
| 8 | 14 | messages still guessed when doubt carried over from an earlier save ("someone else changed it" about the manager's own save). **The doubt became data**: the (version, value) a doubtful save carried. Under If-Match that save can only land while the row is at that version, so any load or 412 at another version ends the doubt, and messages say what the server holds, and whose save it was when known, without ever guessing "someone else". Also: response versions checked against the row's real `xmin`, If-Match lists, and every test that writes a person restores it |
| 9 | 9 | the capacity numbers were independently confirmed again (28,000 person-weeks). Both reviewers found the save loop putting back a doubt a load had already resolved; fixed by removal (the loop and reducer now consult the version they already know). A real concurrency test now proves the version check and the write are one atomic step |
| 10 | 16 | the save loop still read "the row seen at another version" in one branch but not its parallel one, and a load showing *our* value counted as a conflict. Fixed in one place: a single function reads such a row, whether a 412 or a load brought it, and every branch after an unknown attempt consults it. Also a real gap in the round-6 guarantee: the editor saved on the version current at *Save*, so a stale draft could still overwrite a change a load had brought in; it now saves on the row it was opened from. Ten gaps in the tests closed, each proven by a mutant it kills |
| 11 | 9 | two findings came from round 10's own fixes: a save already known to be stale was sent anyway and then reported "may have been stored", and the edge-year guard silently refused some ranges. The editor's message was a snapshot that a later load could disprove; it is now worked out from the row as it is, so it stays true. A late save answer was to reload the range when a newer row had been seen (this did not hold; see round 12). Ranges are moved back inside the supported years instead of refused. Five gaps in the tests closed |
| 12 | 11 | for the third round running, the findings came from the previous round's fixes: "save again to apply it" didn't save, because the editor's message and its save were about different rows; "your save went through" was claimed when that can't be known; and the late-answer reload read a copy of the state that lags. **Redesigned by subtraction**: one rule for which row a save is about (the one the manager was last shown); the reload deleted, with the reducer deciding a late answer from the version the save was sent on; and messages that say what the server holds, never whose save it was (round 8's "whose save, when known" is withdrawn: under If-Match it is never known) |
| 13 | 8 | round 12's redesign held where it was applied; the findings came from where it wasn't. The reducer's new rule for a late answer wasn't carried into the save loop beside it, so the editor and the grid could settle on different rows; the rule now covers only a stored answer (200), where the order is certain, and both read a 412's row the same way. "The server holds what you typed" no longer depends on whether the save was in doubt, so Retry is never offered with nothing to send |
| 14 | 9 | none of the findings came from round 13's fixes: the chain of fixes producing the next round's findings is broken. An older gap: a Retry of a save whose earlier identical attempt was still in doubt could say "Not saved". A late load is now placed against a stored save too, the parallel of round 12's rule. Information ("the server holds what you typed") is no longer styled as an error. Ten gaps in the tests closed, mostly presentation and accessibility |
| 15 | 5 | no behaviour defect found: the adversarial reviewer's three are a message's full stop and two outdated comments. Two tests didn't check the cause: the round-14 rule for a load sent during a save was tested in the reducer only, not in the hook that records when the save was sent, and the half-typed-year test could no longer fail since round 11. Both now check the cause |
| 16 | 8 | one real defect, older than round 15: a load and our save could still be misplaced, so the grid kept our 50h as certain while another manager's 60h was on the server. The rule rested on when each attempt was sent; it now rests on when the version the save was written over became known. To before From no longer collapses the range to one week. Three tests checked the reducer with its inputs given by hand; they now drive the hook. The week order is checked under a second query plan |
| 17 | 4 | two High findings with one root, one of them from round 16's change: a save's answer that only showed again the row a load had already shown was taken as news, so a later load's newer row was kept off the grid (60h shown as certain while the server held 70). Such an answer now changes nothing, and a version counts as known from the first time it was shown. Two test gaps: focus after closing on an unchanged value, and the edges of the From/To rules |
| 18 | 7 | the late-answer ordering area failed a seventh time (a 412 or two saves of ours could still keep an older value as certain), so it was redesigned by subtraction: four special mechanisms gave way to one rule that decides only what the facts decide (when each answer was sent and arrived, which versions are known to be older). When an answer's order can't be told, the grid no longer guesses: it marks the row "?" and loads it again. The save loop now also stops when a load shows a new version during its wait. Four test gaps closed (URL history, year 0, fractional bounds) |
| 19 | 11 | round 18's placing rule held: no misplaced answer was found. Its new surface needed work: the "?" could stay with nothing loading, the editor could state a "?" row as the server's value, the note claimed a load was running when none was, and after the database is re-created the repeated versions could keep an old value for good (time now decides first). Six test gaps on the new stamps closed |
| 20 | 5 | no High: the placing rule and the "?" held in every order the reviewer built. The editor's messages now sit in a live region that exists before them, so a screen reader announces them. Four test gaps: saving the value a "?" row shows, a round-17 test that a later change had emptied, year 1 in the API, and a stale line in the plan |
| 21 | 10 | no High for a second round; the save and ordering designs held again. New areas: red text now meets WCAG AA contrast in both themes, a phone-sized screen shows week columns, and abandoned loads and conflicts no longer fill the log as errors. Six test gaps, including a link with a bad `to` and the editor's live region checked as the same node |
| 22 | 13 | no High for a third round. A load now has a time limit (an answer with Retry instead of loading forever), and an abandoned one is still answered. First looks at keyboard focus (a focused row no longer hides under the sticky header or drops focus when scrolled away), printing (every row prints), forced colours and screen readers (the current week is marked), long ranges (headers name the year), and 320px screens. Tests now measure contrast rather than colours, and the sticky header and columns are tested. The e2e run of round 21 had used an API container not rebuilt after its Go changes; this round's ran on a fresh one |
| 23 | 16 | no High for a fourth round. Two of round 22's fixes are redesigned by taking them out: printing no longer renders the whole roster (it froze large ones and still cut columns); it prints the screen and a note says so. On narrow screens only the names stay at the left, readable, and the capacity scrolls with the weeks. The banner ends the API's message as a sentence, the editor's focus return no longer scrolls the grid, and the stale grid is marked without fading its text. The auditor's nine: seven test gaps (one a flaky round-22 test), a doc fix, and red text faded below readable contrast |
| 24 | 10 | no High for a fifth round; the save, ordering and "?" designs held. Printing failed a third time (a scrolled grid printed a sliver of itself), so the grid is no longer printed: the print shows the summary and says why. On narrow screens the capacity header no longer covers the names when scrolled. Tabbing into a scrolled grid starts at a row in view instead of jumping back. Five test and doc gaps |
| 25 | 8 | no High for a sixth round; the adversarial reviewer found only two Lows, both in round 24's Tab entry (it could pick the open editor's disabled button, and Shift+Tab from the browser wasn't handled). The rest are tests for what only the stylesheet draws: the red that makes over-capacity obvious, opaque sticky cells, this week's underline, the edited row's highlight; and Tab moving row by row |

The rule followed: if the same problem comes back a third time, that area is
redesigned rather than patched again. Round 5 added a correction: count every
occurrence, never reset after a redesign. If redesigns keep recurring, the
next one must remove mechanisms, not add them. From round 10 the owner relaxed
the rule to a judgement call: a forced redesign can delay convergence too, so
the count is a signal, and each choice is recorded in the register with its
reason.

**Where the provided scaffold itself was wrong**, with evidence:
[`SCAFFOLD-FINDINGS.md`](SCAFFOLD-FINDINGS.md).

## Run it

```bash
make up                                                            # web :3000, API :8080
docker compose run --rm -v ./api:/src api go test -timeout 180s ./...  # Go, against the seeded DB
docker compose exec web npm test                                   # Vitest
cd e2e && npm install && npx playwright test                       # real browser, with fault injection
```
