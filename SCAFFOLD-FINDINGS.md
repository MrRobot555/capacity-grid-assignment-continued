# What the provided scaffold gets wrong

The assignment shipped a scaffold: a schema and seed, a Go API skeleton, a Vite
app and a Compose setup. Building on it turned up problems in that scaffold
itself, not in the task. Each one below says what is wrong, how it was shown
(a measurement or a test, never an opinion), what it breaks, and what this
repository does about it. Where the run environment was off limits (schema,
seed, Compose), the problem is handled in the code and the fix the scaffold
needs is named.

---

## 1. The brief's three save strategies all assume the save's outcome is known

The brief asks how the grid should stay correct after a save: "refetch the
range, patch what you already have, something optimistic". All three assume the
client knows whether the save happened. It doesn't when the answer is lost: a
client timeout, a proxy's 504, or a connection that drops after the request was
sent. Then:

- **patch** shows the old value (or the new one) with no basis for either;
- **optimistic** rolls back a value that may well be stored;
- **refetch** can read the old value just before the save commits: a proxy
  can give up while the API is still working.

The scaffold's API gave a client no way to find out. Four review rounds kept
finding new ways for the grid to show a value the server didn't hold, until the
server was made able to answer the question:

- every save carries a client-chosen **`Save-Id`**; the API records each
  outcome and answers `GET /api/saves/{id}` (`api/saves.go`);
- an id the API has never seen is **fenced**, so if that request turns up
  later it is refused, and "not stored" stays true;
- when the API loses the answer to its own `COMMIT`, it asks Postgres with
  **`pg_xact_status`**, the feature Postgres has for exactly this;
- `GET /api/capacity` marks people with a save **in progress**, so other tabs
  and other managers see the value as unsettled, not as fact.

**Shown by:** `api/saves_test.go`, and `TestUpdatePersonResolvesALostCommitAnswer`
(a TCP proxy forwards `COMMIT` to Postgres and drops the answer; the API
answers 200 with the stored value). In the browser,
`e2e/tests/editing.spec.ts` has "a save whose answer is lost is found to be
stored": the request reaches the real API, the browser loses the answer, and
the grid learns from the API that the save went through.

## 2. The database image sorts names by byte, whatever its locale says

`postgres:17-alpine` reports the database collation as `en_US.utf8`, but Alpine
uses musl libc, which has no locale-aware collation:

```
select 'Öztürk' < 'Yilmaz';   -- f   (en_US: should be t)
```

So `ORDER BY name` puts "Fatima Öztürk" after "Fatima Yilmaz", and every accented
name sorts after Z. This repository sorts in the browser with `Intl.Collator`
(`web/src/capacityState.ts`).
**The scaffold needs:** a Debian-based Postgres image, or ICU collations
(`CREATE COLLATION … (provider = icu)`).

## 3. The schema accepts data that can't be right

There are no `CHECK` constraints. Both of these are accepted (checked inside a
transaction that was rolled back):

```
insert into people(name, weekly_hours) values ('negative', -5);                   -- accepted
insert into assignments(..., start_date, end_date, ...) values (..., '2026-01-16', '2026-01-12', ...);  -- accepted
```

An assignment that ends before it starts makes the natural overlap formula
**subtract** hours: a synthetic test measured −18.5 h in a week. This repository
clamps the overlap at zero (`api/capacity.go`, `TestCapacitySyntheticEdgeCases`)
and validates capacity in the API (0–168).
**The scaffold needs:** `CHECK (end_date >= start_date)`,
`CHECK (hours_per_day > 0)` and `CHECK (weekly_hours BETWEEN 0 AND 168)`.

## 4. The date index can't do the one query this view runs

The scaffold indexes `assignments (start_date, end_date)`. The view's query is
an overlap, `start_date <= X AND end_date >= Y`. A B-tree on that pair can only
bound the first column. It reads every assignment that **started** before the
range ended, which means the whole history before it. For one week near the
end of the data:

| index | buffers read |
|---|---|
| the scaffold's B-tree `(start_date, end_date)` | 147 |
| GiST on `daterange(start_date, end_date, '[]')` | 70 |

At the seed's 126k rows both take about 1 ms. The B-tree's cost grows with how
much history lies before the range; the GiST index's doesn't. With "up to two
years of history" and a few thousand people, that difference is the point.
**The scaffold needs:** the GiST index. It couldn't be added here, because the
schema is fixed.

## 5. Nothing can tell two managers' edits apart

`people` has no version or `updated_at`. When two managers edit the same
person, the last write wins and the first manager is never told. This
repository narrows the window (in-progress saves are visible to every client)
but can't close it without a column.
**The scaffold needs:** a `version` column, `If-Match` on `PATCH`, and a 412
answer the editor can show as "changed by someone else".

## 6. The server skeleton has no timeouts and leaked database errors

- `http.ListenAndServe(":8080", mux)` has no read, write or header timeouts. A
  client that sends its headers slowly holds a connection open indefinitely
  (gosec G114, "slowloris"). This repository uses an `http.Server` with
  timeouts sized to the longest handler (`api/main.go`).
- `handleHealth` answered a failure with `http.Error(w, err.Error(), 500)`. That
  sends the database's own error text, as plain text, to whoever asks. It now
  logs the cause and answers JSON (`TestHealthDoesNotLeakDatabaseErrors`).

## 7. The seed's shape is undocumented, and the obvious reading is wrong

- Every assignment is stored as **15 rows** that must be summed: 14 × h plus 1 × 2h.
  Reading one row, or de-duplicating, gives a fraction of the real hours.
- `hours_per_day` applies to **working days**, but 3,111 assignments run into
  a weekend. Counting calendar days instead of Monday to Friday reports
  **4,779** over-allocated person-weeks instead of **1,626**: nearly three times
  as many false alarms.
- Every third week is empty, an artefact of the generator. This includes the
  week after "today" in the default view.

None of this is mentioned in the brief or the schema. All of it was found by
probing the data. It is verified for every person and week by an independent
day-by-day oracle (`TestCapacityMatchesDayByDayOracle`).

---

*How these were found:* data probing before any code, then four rounds of
review by two independent reviewers (one adversarial with reproductions, one
auditing the tests by mutation), each finding recorded with a verdict in
`.notes/review-register.md`.
