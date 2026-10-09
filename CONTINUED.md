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

The rule followed: if the same problem comes back a third time, that area is
redesigned rather than patched again. Round 5 added a correction: count every
occurrence, never reset after a redesign. If redesigns keep recurring, the
next one must remove mechanisms, not add them.

**Where the provided scaffold itself was wrong**, with evidence:
[`SCAFFOLD-FINDINGS.md`](SCAFFOLD-FINDINGS.md).

## Run it

```bash
make up                                                            # web :3000, API :8080
docker compose run --rm -v ./api:/src api go test -timeout 180s ./...  # Go, against the seeded DB
docker compose exec web npm test                                   # Vitest
cd e2e && npm install && npx playwright test                       # real browser, with fault injection
```
