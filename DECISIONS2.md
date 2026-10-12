# DECISIONS2: why the work went on after the submission, and what it bought

`DECISIONS.md` records the decisions behind the submitted code. This document
covers what came after. The submitted grid worked on the happy path.
Twenty-eight rounds of independent review then showed where it would mislead a
manager once the network, the database or another manager did something
ordinary but unhappy. Every finding is in
[`.notes/review-register.md`](.notes/review-register.md) with a verdict,
a test, and the mutant that test kills. This document explains why the work was
needed, why it reached into the API, and where it leaves the system.

**In short.** The submitted state answered the brief's questions for the case
where every request succeeds and one manager is editing. This repository makes
the capacity view **production-ready within the assignment's scope**:
- **Correct numbers:** proven against an independent oracle.
- **Saves:** they stay honest when answers are lost, delayed, refused or
  overtaken by another manager's change.
- **Errors:** an API that fails in bounded time, with a reason.
- **People:** a UI that works for keyboard, screen-reader and phone users.

The review closed with **zero user-perceptible defects** (round 28). A few
known limits remain, and they are listed at the end with what fixing them
would take.

---

## 1. What the submitted state did not meet

None of these show up when you click through the grid on a fast local machine.
All of them appear in ordinary use, and each was reproduced before it was fixed.

- **A save whose answer is lost was reported wrongly.** The brief's three
  strategies (refetch, patch, optimistic) all assume the client knows whether
  the save happened. When the answer is lost (a client timeout, a proxy's 504,
  a dropped connection) it doesn't. In the submitted state the grid could show
  40 h as current while the database held 50 h. Re-typing 40 then sent nothing,
  because the value "hadn't changed" (R1-A1, High).
- **"Not saved" was said while the value could still be saved.** The API's
  save timeout was a Go context deadline, which only stops Go waiting. An UPDATE
  queued behind a row lock still committed after the API had answered
  "not saved" (R1-X1, High). A "flaky" browser test was this real bug.
- **Two managers editing the same person overwrote each other silently.** The
  table has no row version, so the last write won and the first manager was
  never told (SCAFFOLD-FINDINGS §5).
- **A save that never answered locked all editing until a page reload.** There
  was no client timeout and no database timeout (R1-A4).
- **A typed date landed on the wrong date.** The snapped Monday was written back
  into the date field while the manager was still typing, so "03/02/2026"
  became 2024-12-02, with five requests on the way (R1-A2).
- **Focus jumped.** The editor's autofocus fired again whenever its row
  remounted while scrolling or searching (R1-A3).
- **Late answers could show an old number as certain.** A slow load and a save
  arriving in the "wrong" order could leave another manager's newer value off
  the grid, shown as certain (R16-A1, R17-A1/A2, R18-A1/A2, all High).

These are not polish. Each one either shows the manager a wrong number as fact,
tells them something false about their save, or loses an edit. That is the
High tier of the severity scale the reviews used.

## 2. Why the work reached into the API

The brief assigned the two API endpoints as `TODO`s (`GET /api/capacity`,
`PATCH /api/people/{id}`), so writing them was part of the task. Two changes
went beyond the endpoints, and four changed the contract between the API and
the grid. Each is backed by a test that fails without it.

### Changes to the scaffold's own server code (`api/main.go`)

- **HTTP timeouts.** The scaffold used `http.ListenAndServe`, which has no
  read, write or header timeout. A client that sends its headers slowly holds a
  connection open indefinitely ("slowloris", gosec G114). The server now has
  timeouts sized to its longest handler. `TestServerTimeoutsOutlastASave` pins
  that the write timeout outlasts a save, so a slow save's answer is never cut
  off.
- **No database errors leaked to clients.** The health check sent
  `err.Error()` (the database's own error text, as plain text) to whoever asked.
  It now logs the cause and answers JSON (`TestHealthDoesNotLeakDatabaseErrors`).

### Changes to the contract, because correctness needed them

- **A row version: `xmin`, with `If-Match` and 412.** Without a version, the
  server cannot tell a repeat of an old change from a current one. So neither a
  lost answer nor a concurrent edit can be settled. Postgres's `xmin` system
  column changes on every update and needs no schema change.
  - The grid sends it back as `If-Match`.
  - The `UPDATE` applies only if the row is still at that version.
  - A stale save gets **412 with the current row**.
  - A lost answer is then settled by sending the identical request again: it
    applies if the first attempt never landed, and otherwise it meets the new
    version and gets the stored row back.

  Shown by `TestLostCommitIsUnknownAndARepeatSettlesIt`, where a TCP proxy loses
  the COMMIT's outcome three different ways. `TestConcurrentSaveOnTheSameVersionLosesNothing`
  shows the check and the write are one atomic step.
- **The time limit enforced by Postgres, not by Go.** A save's
  `statement_timeout` is set for its own transaction only. Postgres cancels a
  stuck UPDATE, so "503: the database didn't respond in time" really means
  nothing was stored. Shown with a held row lock (`TestUpdatePersonGivesUpOnALockedRow`):
  after the lock is released, the row still holds the old value.
- **"Stored: unknown" when the COMMIT's answer is lost.** The API says it
  doesn't know instead of guessing, and the grid's identical repeat settles it.
- **A deadline for loads.** 10 s in the API (a 503 with a reason) and 15 s in
  the client (a banner with Retry). Before this, a load stuck behind a lock
  never ended (`TestCapacityGivesUpBehindALock`).

These form one deadline chain (Postgres 10 s < API 12 s < client 15 s), so the
server always answers before the client gives up. A client timeout therefore
means the answer was lost, never that the server was still deciding.

### What was deliberately not changed

The schema, the seed, Compose, the Dockerfiles and the Makefile are fixed
input for this assignment. Where they are wrong (sorting accented names, no
`CHECK` constraints, an index that can't serve an overlap query, no version
column), the problem is handled in code where it can be. The change the scaffold
needs is named in [`SCAFFOLD-FINDINGS.md`](SCAFFOLD-FINDINGS.md), each with the
measurement that shows it.

## 3. What "production-ready" covers here

Beyond the brief's functional points, the system now accounts for the
following. Each line is backed by tests in the repository.

| Concern | What the system does | How it is shown |
|---|---|---|
| **Correct numbers** | Hours are summed per working day across week boundaries. A capacity of 0 never divides. Status uses the same rounding as the display | `TestCapacityMatchesDayByDayOracle` recomputes every person and week independently. In the last round, a reviewer recomputed 500 people over 85 weeks with 0 mismatches |
| **Concurrent managers** | Optimistic concurrency with a row version. A stale save is refused with the current row, never silently overwritten | Go concurrency test; e2e "a save on a stale view doesn't overwrite another manager's change" |
| **Unreliable networks** | Up to 5 attempts, 1/2/4/8 s apart, each repeat identical and conditional. "?" is shown while the outcome is unknown. Retrying stops once the save can no longer land | Vitest save-loop suite (111 tests); Go tests with a proxy that loses the COMMIT's answer; e2e lost-answer tests |
| **Late and out-of-order answers** | One rule (`place`) decides from facts: when each answer was sent and arrived, and which versions are known to be older. When the order can't be decided, the row is marked "?" and reloaded, never guessed | Reducer tests plus hook-level tests that drive every order of loads, 200s and 412s |
| **Honest messages** | Nothing is stated that isn't known. A value of unknown order is never given as the server's value | Message tests for every outcome; reviewed in every round |
| **Bounded failure** | Every load and save ends in bounded time with a reason. Only real failures are logged | Lock, dead-pool and lost-COMMIT tests in Go |
| **Scale** | Virtualised rows (a few thousand people, up to 106 weeks). The query's cost is checked under a second plan | e2e virtualisation tests; the query plan's cost is tested, and its results are checked under a second plan |
| **Dates** | UTC arithmetic. A typed date is applied only when complete. Years 2000–2099 are kept, and labels name the year past 52 weeks. The range lives in the URL without polluting history | Time-zone tests in three zones; e2e controls suite |
| **Accessibility** | Polite live region for the editor's messages. Focus management (return, Tab entry, never hidden under the sticky header). WCAG AA contrast in light and dark themes. Forced-colours mode. Screen-reader labels and the current week marked | e2e layout suite, which measures contrast and reads computed styles |
| **Phones and zoom** | Below 40rem only names stay sticky, so a whole week always fits beside them | e2e at 390 and 320 px |
| **Input** | Comma or point decimals. A comma before three digits is asked about rather than guessed. Plain decimals only | Parser tests; editor tests |
| **Printing** | A virtualised, scrolling grid can't print itself. It is left out of print, and the page says so | e2e print test |

**Tests at close:** Go (with an oracle and proxy-driven failure tests),
Vitest 185, Playwright 60.
- **Gates:** every fix has a test, and that test was shown to fail on a mutant
  that puts the defect back.
- **Timing:** the timing-dependent tests pass under heavy CPU load.

## 4. Why it took 28 rounds

The method was strict on purpose:
- **Reviewers:** each round had two independent reviewers. One was adversarial
  and reproduced every finding; the other audited the tests by mutation.
- **The register:** every finding got a verdict.
- **Fixes:** every fix got a gate.
- **Closing:** a cycle closes only when a round finds nothing.

| Rounds | Findings | What was going on |
|---|---|---|
| 1–10 | 21, 18, 14, 9, 23, 13, 6, 14, 9, 16 | **Finding the right model for a save's outcome.** Several designs added machinery to *track* doubt, including a server-side outcome registry. Each layer brought new defects. It ended by subtraction: the row version (`xmin` + `If-Match`) made every repeat safe, and the machinery was deleted |
| 11–19 | 9, 11, 8, 9, 5, 8, 4, 7, 11 | **The order of late answers.** Each fix was a special case resting on a stand-in, and each round found its edge. In round 18 one rule replaced five mechanisms; it decides only what the facts decide and re-reads otherwise. No reviewer found a fault in it afterwards |
| 20–26 | 5, 10, 13, 16, 10, 8, 10 | **New surfaces:** contrast, narrow screens, keyboard focus, printing, logging, input locales. Then a long tail of small edges and ungated stylesheet rules |
| 27–28 | 3, 0 | The owner set the closing threshold to **user-perceptible defects**, which ended the oscillation of the long tail. Round 28 found none |

About 270 findings were recorded after the submission. Thirty were rated High:
a wrong number shown as certain, a false statement, or a lost edit. **No High
finding was raised in the last nine rounds.** The core (saving, the ordering of
answers and the "?" state) drew no finding from round 20 on.

Three lessons shaped the work, and they are why the result holds:
- **Redesign by subtraction.** When an area kept failing, the answer was to
  remove machinery and rest on a fact, not to add a mechanism.
- **The recurring defect is the act of fixing.** A fix applied where a problem
  was raised but not to its parallel path, or moved rather than removed,
  produced most of the next round's findings. Every fix is now checked for
  both.
- **A gate must measure the cause.** A test that feeds the cause in by hand,
  or that a later change made unable to fail, protects nothing. Each gate was
  shown to fail on a mutant before it counted.

## 5. What remains, and what it would take

### Versions repeat after the database is re-created (R19-F1)

`xmin` is a 32-bit transaction id. It is the right tool for "has this row
changed since I read it?" over seconds or minutes. It is not a durable
version, because re-creating or restoring the database starts it again. Two
fresh clusters built from the same schema and seed gave identical ids: seed
rows at 743, the first update at 751.

**Why it matters.**
1. A manager leaves a tab open while the database is re-created or restored
   (a reset, a restore from backup).
2. The tab still holds a version such as 751.
3. After the restore, someone saves that person, and the row lands on 751 again
   with different data.
4. The old tab's save sends `If-Match: "751"`, matches, and overwrites. There
   is no 412, because the version looks current.

The grid itself recovers when it next reads the row: time decides before the
version list, so a repeated version can't keep an old value on screen. But the
save can't tell.

**What fixing it takes.** A version column of the application's own, for
example `version bigint NOT NULL DEFAULT 1`, incremented in the same
conditional `UPDATE` (`SET … , version = version + 1 WHERE id = $1 AND version = $2`).
It survives restores and re-creation, and it is never reused. That is a
change to `db/schema.sql`, which this assignment declares fixed input, so it
is recommended here rather than made. The API and the grid already speak
"version", so only the column and the query would change.

### Other follow-ups (all below the closing threshold)
- **A range longer than 106 weeks is shortened without a notice.** The summary
  line shows the real range. A one-line notice would be kinder (R28-F2).
- **A screen reader's virtual cursor has not been checked with a real screen
  reader.** It may be read as backward Tab entry into the grid (R28-F3).
- **The scaffold's own needs:**
  - `CHECK` constraints on hours and dates;
  - a GiST index for the overlap query;
  - an ICU or glibc collation, so accented names sort correctly.

  See SCAFFOLD-FINDINGS.
- **`DECISIONS.md` predates the review rounds.** Three of its statements are
  now outdated, for example "the last save wins without any warning". The list
  is in `.notes/next-steps.md` for its author.

---

*Where to look:* [`CONTINUED.md`](CONTINUED.md) summarises every round.
[`.notes/review-register.md`](.notes/review-register.md) lists every finding
with its verdict and gate. [`.notes/worklog.md`](.notes/worklog.md) is the
running record.
