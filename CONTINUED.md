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
| 4 | 9 | the remaining gap could only be closed **server-side**: save outcomes the API can answer for (`Save-Id`, fencing, `pg_xact_status`) and in-progress saves visible to every client |

The rule followed: if the same problem comes back a third time, that area is
redesigned rather than patched again.

**Where the provided scaffold itself was wrong**, with evidence:
[`SCAFFOLD-FINDINGS.md`](SCAFFOLD-FINDINGS.md).

## Run it

```bash
make up                                                            # web :3000, API :8080
docker compose run --rm -v ./api:/src api go test -timeout 180s ./...  # Go, against the seeded DB
docker compose exec web npm test                                   # Vitest
cd e2e && npm install && npx playwright test                       # real browser, with fault injection
```
