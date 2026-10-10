# Next steps: resuming the review cycle

Paused at the owner's request after **review round 12** (all of its findings
fixed, committed and pushed). Resume with **round 13**: run the two reviewers
with the briefs below, updated to HEAD and to round 12's changes.

## Where things are

| | |
|---|---|
| Submitted repo (frozen) | https://github.com/MrRobot555/capacity-grid-assignment, `main` @ `f772a98`. Never push there (its push URL is disabled locally). |
| Continuation repo | https://github.com/MrRobot555/capacity-grid-assignment-continued, `main`. Every round is pushed here. |
| Local working copy | branch `continued`, tracking `continued/main`; `git push` goes there (`push.default upstream`). |
| Register | `.notes/review-register.md`: every finding with a verdict, plus the Recurrence table. |
| Narrative | `.notes/worklog.md` (append only), `CONTINUED.md`, `SCAFFOLD-FINDINGS.md`. |

Findings per round: 23 → 18 → 14 → 9 → 23 → 13 → 6 → 14 → 9 → 16 → 9 → 11. Round 5's rise
taught the counting rule below; since then the design has been simplified, not
grown.

## The process (owner's rules)

1. **Two reviewers per round, in parallel, with fresh context:**
   - an **adversarial** reviewer: "what does this code do today that its design doesn't account for?", with reproductions;
   - a **gate auditor**: "could this test pass while its defect is present?", proven by mutation testing in a scratch copy.
2. **Freeze the tree** while they work: no edits, commits or rebuilds until **both** have reported.
3. **Triage everything into the register before fixing.** Never re-raise a closed finding without new evidence.
4. **The 3-recurrence rule:** count recurrences per *area* across the whole register, **never resetting after a redesign**. Since round 10 (owner, 2026-10-10) the count is a signal, not an order: at three, choose a redesign or a patch on the merits, whichever converges without leaving a defect, and record the choice and why. If redesigns keep recurring, the next one must **remove** mechanisms, not add them. (The owner's corrections are in the register's Recurrence section.)
5. **Every fix gets a gate, and every gate is checked:** it must fail on the pre-fix code, or kill the mutant it targets. Then run the half-migration grep: did the removed concept actually go away, or just move?
6. **After every round:** all suites green, the seed intact, then **commit and push** to the continuation repo.
7. **Then the convergence report to the owner, before the next reviewers start** (owner, 2026-10-10): a table per round (findings, High/Medium/Low from the register, what changed) and what it means: converged or not, what is improving, what keeps recurring.
8. A cycle closes only when a round returns **zero** findings. Reviewers are told not to invent findings to avoid saying "converged".

## Hard-won rules for running it

- **Only one agent runs the shared-database suites (Go, Playwright) at a time.** The other probes persons ≥ 6. Parallel runs caused false failures and stomped on each other's probes.
- **After every mutant run**, diff all 500 people against `db/seed.sql` and restore any difference. Mutants let writes through that the real code refuses (round 5 left person 10 at 22).
- **Every test that writes a person restores it** in `t.Cleanup`.
- **Any `go test` that can hang gets `-timeout`.** Never kill a container mid-test: that once committed an abandoned UPDATE.
- **Make checks print their result.** A silent `test -z "$(gofmt -l .)" &&` guard once skipped the whole Go suite without saying so.
- **Never edit** `DECISIONS.md` (owner's text), `db/`, `docker-compose.yml`, the Dockerfiles or the `Makefile`.

## Commands

```bash
make up    # or: docker compose up -d --build api   (after Go changes)
docker compose run --rm --no-deps -v ./api:/src api sh -c 'echo "gofmt: [$(gofmt -l .)]"; go vet ./... && go test -count=1 -timeout 180s ./...'
docker compose exec -T web sh -c 'npx tsc --noEmit && npm test && npm run build'
cd e2e && npx playwright test

# seed check (must print nothing)
awk '/^COPY public.people/{f=1;next} /^\\\./{f=0} f' db/seed.sql | awk -F'\t' '{print $1"="$3}' | sort > /tmp/seed.txt
docker compose exec -T db psql -U capacity -d capacity -At -c "select id||'='||weekly_hours from people" | sort | diff /tmp/seed.txt -
```

## Reviewer briefs (as used in round 10)

Both briefs include:
- the repo path and branch `continued`;
- "read `.notes/review-register.md` first";
- the scope: `api/*.go`, `web/src/*`, `e2e/*` and the repo's own docs, with `db/`, Compose, the Dockerfiles, the `Makefile` and `DECISIONS.md` out of scope (problems there go under follow-ups);
- the severity scale: High = wrong numbers, lost or false data, or a false statement to the manager; Medium = a user-visible malfunction or a false doc claim; Low = the rest;
- the hard rules: no repo edits, scratch dir only, restore the DB, `-timeout`, and who may run the shared-DB suites;
- "zero findings is a valid answer; say converged if true".

The **adversarial** brief summarises the current design (row version from `xmin`; `If-Match` with 412 + the current row; doubt as a (version, values) pair resolved by observing the row; retries that stop once the save can no longer land; one `settledBy` reading of a row seen at another version; the editor saving on the row the manager was last shown (`shownRow`); a late save answer decided in the reducer from the version it was sent on; messages that never say whose save a value was) and asks for anything still wrong, in any area.

The **gate auditor** brief asks it to verify a sample of the last round's kill claims, then hunt for unguarded behaviour, vacuous or flaky tests, and doc claims that name tests which don't show them. It does its mutation testing in an rsync copy, serving mutated web code on :3001.

## Open items for the owner

- **`DECISIONS.md`** is the owner's text and was written before the review rounds. Some statements are now outdated:
  - "Two managers editing the same person: right now the last save wins without any warning". Since round 6 the grid gets a 412 conflict instead.
  - "Retrying is fine either way, it just sets the value again". A repeat is now conditional on the version.
- **`CONTEXT.md`** is the owner's private helper for writing `DECISIONS.md` (untracked). It describes the submitted state; whether to update it is the owner's call.
