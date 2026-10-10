package main

// Integration tests against the seeded database. They need DATABASE_URL and
// skip without it. Run them inside Compose:
//
//	docker compose run --rm -v ./api:/src api go test ./...

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testServer(t *testing.T) *server {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	db, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return newServer(db)
}

// restoreCem puts Cem (id 3, seeded at 20 h) back after a test that writes
// him. It writes with SQL, not through the handler under test: a broken
// handler must not also leave the next run's data wrong.
func restoreCem(t *testing.T, s *server) {
	t.Cleanup(func() {
		if _, err := s.db.Exec(context.Background(), `UPDATE people SET weekly_hours = 20 WHERE id = 3`); err != nil {
			t.Errorf("restoring Cem: %v", err)
		}
	})
}

func do(t *testing.T, s *server, method, url, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest(method, url, strings.NewReader(body)))
	return rec
}

// The first five seeded people are hand-built edge cases. These numbers were
// worked out by hand from their assignment rows (see .notes/plan.md).
func TestCapacityFixturePeople(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, "GET", "/api/capacity?from=2025-12-29&to=2026-01-16", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var resp capacityResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}

	wantWeeks := []string{"2025-12-29", "2026-01-05", "2026-01-12"}
	if !reflect.DeepEqual(resp.Weeks, wantWeeks) {
		t.Fatalf("weeks = %v, want %v", resp.Weeks, wantWeeks)
	}

	want := map[int]struct {
		weeklyHours float64
		allocated   []float64
	}{
		1: {40, []float64{40, 0, 30}}, // Mon–Sun assignment: weekend adds nothing, exactly full
		2: {40, []float64{0, 32, 8}},  // Fri→Mon assignment split across the week boundary
		3: {20, []float64{0, 4, 12}},  // part-timer
		4: {40, []float64{0, 45, 40}}, // overlapping assignments → over
		5: {0, []float64{0, 20, 0}},   // zero capacity, still allocated
	}
	seen := 0
	for _, p := range resp.People {
		w, ok := want[p.ID]
		if !ok {
			continue
		}
		seen++
		if p.WeeklyHours != w.weeklyHours || !reflect.DeepEqual(p.Allocated, w.allocated) {
			t.Errorf("person %d (%s): got %v/%v, want %v/%v",
				p.ID, p.Name, p.WeeklyHours, p.Allocated, w.weeklyHours, w.allocated)
		}
	}
	if seen != len(want) {
		t.Errorf("found %d of %d fixture people", seen, len(want))
	}
	if len(resp.People) != 500 {
		t.Errorf("got %d people, want every person (500) including unallocated ones", len(resp.People))
	}
}

func TestCapacityRangeSnapsToWholeWeeks(t *testing.T) {
	s := testServer(t)
	for _, tc := range []struct {
		query string
		want  []string
	}{
		// Wednesday → Sunday: the Wednesday's week through the Sunday's week.
		{"from=2025-12-31&to=2026-01-11", []string{"2025-12-29", "2026-01-05"}},
		// A Sunday belongs to the week that started the Monday before, not the next one.
		{"from=2026-01-04&to=2026-01-04", []string{"2025-12-29"}},
		// "to" is inclusive: a Monday "to" brings in its own week.
		{"from=2026-01-05&to=2026-01-12", []string{"2026-01-05", "2026-01-12"}},
		{"from=2026-01-05&to=2026-01-05", []string{"2026-01-05"}},
	} {
		rec := do(t, s, "GET", "/api/capacity?"+tc.query, "")
		var resp capacityResponse
		if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(resp.Weeks, tc.want) {
			t.Errorf("%s: weeks = %v, want %v", tc.query, resp.Weeks, tc.want)
		}
	}
}

func TestCapacityRejectsBadRanges(t *testing.T) {
	s := testServer(t)
	for _, q := range []string{
		"",
		"from=2026-01-05",
		"from=nope&to=2026-01-05",
		"from=2026-01-12&to=2026-01-05",
		"from=2024-01-01&to=2026-12-31",
		"from=2026-02-30&to=2026-03-01", // no such day
		"from=%202026-01-05&to=2026-01-11",
		"from=2026-01-05&to=2028-01-17", // 107 weeks
		"from=0000-01-03&to=0000-01-09", // year 0: weeks would format as "-0001-12-27"
	} {
		if rec := do(t, s, "GET", "/api/capacity?"+q, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%q: status %d, want 400", q, rec.Code)
		}
	}
}

func TestCapacityAllowsExactlyMaxWeeks(t *testing.T) {
	s := testServer(t)
	// 2026-01-05 → 2028-01-16 is 106 Monday-to-Sunday weeks (742 days).
	rec := do(t, s, "GET", "/api/capacity?from=2026-01-05&to=2028-01-16", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var resp capacityResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Weeks) != maxWeeks {
		t.Errorf("got %d weeks, want %d", len(resp.Weeks), maxWeeks)
	}
}

// A range far too long is refused without building its weeks: the list stops
// growing at the limit, so it is the one allocation made up front.
func TestTooLongRangeIsRefusedWithoutBuildingIt(t *testing.T) {
	from, to := time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
	if _, ok := weekStarts(from, to); ok {
		t.Fatal("0001..9999 must be refused")
	}
	if allocs := testing.AllocsPerRun(5, func() { weekStarts(from, to) }); allocs > 1 {
		t.Errorf("%v allocations: the weeks of a refused range were built anyway", allocs)
	}
}

func TestUpdatePerson(t *testing.T) {
	s := testServer(t)
	// Cem (id 3) is restored afterwards so the fixture test stays valid.
	restoreCem(t, s)

	rec := do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 32.5}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var p person
	if err := json.NewDecoder(rec.Body).Decode(&p); err != nil {
		t.Fatal(err)
	}
	if p.ID != 3 || p.Name != "Cem Aydin" || p.WeeklyHours != 32.5 || p.Version == "" {
		t.Errorf("got %+v, want Cem Aydin at 32.5 with the row's new version", p)
	}
	// The response must be what was stored, not an echo of the request.
	var stored float64
	if err := s.db.QueryRow(context.Background(), `SELECT weekly_hours::float8 FROM people WHERE id = 3`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 32.5 {
		t.Errorf("stored weekly_hours = %v, want 32.5", stored)
	}

	for _, tc := range []struct {
		url, body string
		status    int
	}{
		{"/api/people/abc", `{"weeklyHours": 10}`, http.StatusBadRequest},
		{"/api/people/3", `{}`, http.StatusBadRequest},
		{"/api/people/3", `{"weeklyHours": "10"}`, http.StatusBadRequest},
		{"/api/people/3", `{"weeklyHours": -1}`, http.StatusBadRequest},
		{"/api/people/3", `{"weeklyHours": 169}`, http.StatusBadRequest},
		{"/api/people/3", `{"weeklyHours": 10, "name": "x"}`, http.StatusBadRequest},
		{"/api/people/999999", `{"weeklyHours": 10}`, http.StatusNotFound},
		{"/api/people/0", `{"weeklyHours": 10}`, http.StatusBadRequest},
		{"/api/people/99999999999", `{"weeklyHours": 10}`, http.StatusBadRequest}, // beyond int4
		{"/api/people/3", `{"weeklyHours": 10} trailing`, http.StatusBadRequest},
		{"/api/people/3", `{"weeklyHours": 10}{"weeklyHours": 20}`, http.StatusBadRequest},
		{"/api/people/3", `null`, http.StatusBadRequest},
		{"/api/people/3", ``, http.StatusBadRequest},
	} {
		if rec := do(t, s, "PATCH", tc.url, tc.body); rec.Code != tc.status {
			t.Errorf("%s %s: status %d, want %d", tc.url, tc.body, rec.Code, tc.status)
		}
	}
}

// A save stuck behind a lock (another transaction holding the row) must end
// with a definite answer rather than hang; the client's own timeout is longer,
// so the server's "not saved" is what the manager sees.
func TestUpdatePersonGivesUpOnALockedRow(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	ctx := context.Background()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM people WHERE id = 3 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	saved := updateTimeout
	updateTimeout = 300 * time.Millisecond
	t.Cleanup(func() { updateTimeout = saved })
	logs := captureLog(t)

	start := time.Now()
	rec := do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 21}`)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("took %v; it should give up after the timeout", elapsed)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503: %s", rec.Code, rec.Body)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// "Not saved" must stay true after the lock is released: an UPDATE that was
	// only abandoned on the Go side would now go through and commit.
	time.Sleep(500 * time.Millisecond)
	var stored float64
	if err := s.db.QueryRow(ctx, `SELECT weekly_hours::float8 FROM people WHERE id = 3`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 20 {
		t.Errorf("stored weekly_hours = %v, want the seeded 20", stored)
	}
	if !strings.Contains(logs.String(), "update person 3:") || !strings.Contains(logs.String(), "57014") {
		t.Errorf("the failure was not logged; log output: %q", logs.String())
	}
}

// A 500 must leave a trace in `make logs`; the client only gets a generic message.
func TestCapacityLogsWhyItFailed(t *testing.T) {
	s := testServer(t)
	logs := captureLog(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the query fails at once
	req := httptest.NewRequest("GET", "/api/capacity?from=2026-01-05&to=2026-01-11", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if !strings.Contains(logs.String(), "load capacity 2026-01-05..2026-01-05") {
		t.Errorf("the failure was not logged; log output: %q", logs.String())
	}
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

func TestCommitOutcome(t *testing.T) {
	if commitOutcome(nil) != nil {
		t.Error("a successful commit must stay successful")
	}
	refused := &pgconn.PgError{Code: "40001"} // e.g. serialization failure: Postgres rolled back
	if err := commitOutcome(refused); errors.Is(err, errOutcomeUnknown) {
		t.Errorf("a COMMIT Postgres refused is a definite failure, got %v", err)
	}
	if err := commitOutcome(errors.New("conn closed")); !errors.Is(err, errOutcomeUnknown) {
		t.Errorf("a COMMIT with no answer must be an unknown outcome, got %v", err)
	}
}

// The save path's own 500 must leave a trace in the log, like the capacity one.
func TestUpdatePersonLogsWhyItFailed(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	logs := captureLog(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("PATCH", "/api/people/3", strings.NewReader(`{"weeklyHours": 21}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if !strings.Contains(logs.String(), "update person 3:") {
		t.Errorf("the failure was not logged; log output: %q", logs.String())
	}
}

func TestUpdatePersonAcceptsZero(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	if rec := do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 0}`); rec.Code != http.StatusOK || storedHours(t, s, 3) != 0 {
		t.Errorf("0 h (someone on leave, like the seeded Eli) must be accepted: status %d", rec.Code)
	}
}

func TestServerTimeoutsOutlastASave(t *testing.T) {
	srv := newHTTPServer(http.NotFoundHandler())
	if srv.WriteTimeout <= saveDeadline() {
		t.Errorf("WriteTimeout %v must outlast the save deadline %v, or a slow save's answer is cut off", srv.WriteTimeout, saveDeadline())
	}
	if srv.ReadHeaderTimeout <= 0 || srv.ReadTimeout <= 0 || srv.IdleTimeout <= 0 {
		t.Error("the server must time out slow headers, slow bodies and idle connections")
	}
}

func TestUpdatePersonAcceptsTheWholeWeek(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	if rec := do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 168}`); rec.Code != http.StatusOK {
		t.Errorf("168 h (every hour of the week) must be accepted: status %d", rec.Code)
	}
}

func TestSaveErrorResponse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		stored string
	}{
		{"COMMIT with no answer", commitOutcome(errors.New("conn closed")), 500, "unknown"},
		{"the save's deadline during COMMIT", commitOutcome(context.DeadlineExceeded), 500, "unknown"},
		{"COMMIT refused by Postgres", commitOutcome(&pgconn.PgError{Code: "40001"}), 500, ""},
		{"statement timeout", &pgconn.PgError{Code: "57014"}, 503, ""},
		{"stale version", &staleError{current: person{ID: 3}}, 412, ""},
		{"no connection in time", fmt.Errorf("begin: %w", context.DeadlineExceeded), 503, ""},
		{"unknown person", pgx.ErrNoRows, 404, ""},
		{"anything else", errors.New("boom"), 500, ""},
	} {
		status, body := saveErrorResponse(tc.err)
		stored, _ := body["stored"].(string)
		if status != tc.status || stored != tc.stored || body["error"] == "" {
			t.Errorf("%s: got %d %v, want %d with stored=%q", tc.name, status, body, tc.status, tc.stored)
		}
	}
}

// End to end through a TCP proxy that loses the outcome of COMMIT in three
// ways. The API can't know whether the save is stored, so it must say
// "stored: unknown", never anything the client reads as "not saved". The
// client's repeat of the identical request (same If-Match) then settles it:
// 200 if the first attempt never landed, or 412 whose current row shows the
// value it set. Either way the value is stored once, and never over a newer change.
func TestLostCommitIsUnknownAndARepeatSettlesIt(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mode   proxyMode
		repeat int // the repeat's answer
	}{
		{"COMMIT reaches Postgres, its answer is lost", proxyCut, http.StatusPreconditionFailed},
		{"COMMIT never reaches Postgres", proxyDrop, http.StatusOK},
		{"the answer is held until the save's deadline", proxyStall, http.StatusPreconditionFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t)
			saved := updateTimeout
			updateTimeout = 300 * time.Millisecond // so the stall case ends at the 2.3 s deadline
			t.Cleanup(func() { updateTimeout = saved })
			restoreCem(t, s)
			version := versionOf(t, s, 3)

			proxied := newServer(proxiedPool(t, tc.mode))
			start := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			req := httptest.NewRequest("PATCH", "/api/people/3", strings.NewReader(`{"weeklyHours": 33}`)).WithContext(ctx)
			req.Header.Set("If-Match", `"`+version+`"`)
			rec := httptest.NewRecorder()
			proxied.routes().ServeHTTP(rec, req)
			if took := time.Since(start); took > saveDeadline()+time.Second {
				t.Errorf("answered after %v; the whole save has a %v deadline", took, saveDeadline())
			}
			if body := decodeBody(t, rec); body["stored"] != "unknown" {
				t.Fatalf("the outcome of COMMIT was lost, so the answer must be stored: unknown; got %d %v", rec.Code, body)
			}

			repeat := patchIfMatch(t, s, "3", version, `{"weeklyHours": 33}`)
			if repeat.Code != tc.repeat {
				t.Errorf("repeat: status %d %s, want %d", repeat.Code, repeat.Body, tc.repeat)
			}
			if tc.repeat == http.StatusPreconditionFailed {
				current, _ := decodeBody(t, repeat)["current"].(map[string]any)
				if current == nil || current["weeklyHours"] != 33.0 {
					t.Errorf("412 current = %v; it must show the stored 33, so the client can tell its save landed", current)
				}
			}
			if h := storedHours(t, s, 3); h != 33 {
				t.Errorf("after the repeat, stored %v, want 33", h)
			}
		})
	}
}

func versionOf(t *testing.T, s *server, id int) string {
	t.Helper()
	var v string
	if err := s.db.QueryRow(context.Background(), `SELECT xmin::text FROM people WHERE id = $1`, id).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func patchIfMatch(t *testing.T, s *server, id, version, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/api/people/"+id, strings.NewReader(body))
	req.Header.Set("If-Match", `"`+version+`"`)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func storedHours(t *testing.T, s *server, id int) float64 {
	t.Helper()
	var h float64
	if err := s.db.QueryRow(context.Background(), `SELECT weekly_hours::float8 FROM people WHERE id = $1`, id).Scan(&h); err != nil {
		t.Fatal(err)
	}
	return h
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	return body
}

// A save made on a stale view must not overwrite a newer change. Two
// managers loaded version v; the first saves; the second, still on v, is told
// the row changed (with the row as it is now), and nothing of theirs is stored.
func TestSaveOnAStaleVersionIsRefused(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	v := versionOf(t, s, 3)

	first := patchIfMatch(t, s, "3", v, `{"weeklyHours": 24}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first: %d %s", first.Code, first.Body)
	}
	if got := decodeBody(t, first)["version"]; got != versionOf(t, s, 3) || got == v {
		t.Errorf("version after a save = %v, want the row's new xmin %s", got, versionOf(t, s, 3))
	}

	second := patchIfMatch(t, s, "3", v, `{"weeklyHours": 30}`)
	body := decodeBody(t, second)
	if second.Code != http.StatusPreconditionFailed || body["stored"] != nil {
		t.Fatalf("second: %d %v, want a definite 412", second.Code, body)
	}
	current, _ := body["current"].(map[string]any)
	if current == nil || current["weeklyHours"] != 24.0 || current["version"] != versionOf(t, s, 3) {
		t.Fatalf("412 current = %v, want the row with 24 and its real version %s", current, versionOf(t, s, 3))
	}
	if h := storedHours(t, s, 3); h != 24 {
		t.Errorf("stored %v, want 24 (the stale save must not land)", h)
	}
	// The 412's version is the one to save on: a deliberate re-save with it lands.
	again := patchIfMatch(t, s, "3", current["version"].(string), `{"weeklyHours": 30}`)
	if again.Code != http.StatusOK || storedHours(t, s, 3) != 30 {
		t.Errorf("re-save on the 412's version: %d %s, stored %v; want 200 and 30", again.Code, again.Body, storedHours(t, s, 3))
	}
}

// A late copy of a request (a proxy that held on to it) carries the version
// its sender saw, so it can't overwrite anything that happened since.
func TestLateCopyCannotOverwriteANewerChange(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	v := versionOf(t, s, 3)
	do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 28}`) // a newer change lands first
	if late := patchIfMatch(t, s, "3", v, `{"weeklyHours": 26}`); late.Code != http.StatusPreconditionFailed {
		t.Errorf("late copy: status %d, want 412", late.Code)
	}
	if h := storedHours(t, s, 3); h != 28 {
		t.Errorf("stored %v, want the newer 28", h)
	}
}

func TestCapacityCarriesEachPersonsVersion(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, "GET", "/api/capacity?from=2026-01-05&to=2026-01-11", "")
	var resp struct {
		People []map[string]any `json:"people"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range resp.People {
		if p["id"] == 3.0 {
			found = true
			if p["version"] != versionOf(t, s, 3) {
				t.Errorf("person 3's version = %v, want the row's xmin %s", p["version"], versionOf(t, s, 3))
			}
		}
	}
	if !found {
		t.Fatal("person 3 is missing from the response")
	}
}

// doWithin is do with a limit: a handler that hangs fails the test instead of
// stalling the suite. The request's context ends at the limit too, so a hung
// handler lets go of its connection and the test's cleanup can't block on it.
func doWithin(t *testing.T, s *server, method, url, body string, limit time.Duration) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	t.Cleanup(cancel)
	req := httptest.NewRequest(method, url, strings.NewReader(body)).WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		s.routes().ServeHTTP(rec, req)
		done <- rec
	}()
	select {
	case rec := <-done:
		if ctx.Err() != nil {
			t.Fatalf("%s %s: no answer within %v", method, url, limit)
		}
		return rec
	case <-time.After(limit + 2*time.Second):
		t.Fatalf("%s %s: no answer within %v, and the handler ignores its context", method, url, limit)
		return nil
	}
}

type proxyMode int

const (
	proxyCut   proxyMode = iota // forward COMMIT, then close the client side
	proxyDrop                   // swallow COMMIT (Postgres never sees it), close both sides
	proxyStall                  // forward COMMIT, never pass its answer back
)

func proxiedPool(t *testing.T, mode proxyMode) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	target := net.JoinHostPort(cfg.ConnConfig.Host, strconv.Itoa(int(cfg.ConnConfig.Port)))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go cutAfterCommit(ln, target, mode)

	host, port, _ := net.SplitHostPort(ln.Addr().String())
	cfg.ConnConfig.Host = host
	p, _ := strconv.Atoi(port)
	cfg.ConnConfig.Port = uint16(p)
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// cutAfterCommit proxies Postgres connections and, once a client sends
// COMMIT, loses its outcome as mode says.
func cutAfterCommit(ln net.Listener, target string, mode proxyMode) {
	for {
		client, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			server, err := net.Dial("tcp", target)
			if err != nil {
				client.Close()
				return
			}
			var cut atomic.Bool
			go func() {
				buf := make([]byte, 64<<10)
				for {
					n, err := server.Read(buf)
					if cut.Load() {
						if mode == proxyStall {
							continue // swallow the answer, keep the connection open
						}
						return
					}
					if n > 0 {
						client.Write(buf[:n])
					}
					if err != nil {
						client.Close()
						return
					}
				}
			}()
			buf := make([]byte, 64<<10)
			for {
				n, err := client.Read(buf)
				if n > 0 {
					if bytes.Contains(bytes.ToLower(buf[:n]), []byte("commit")) {
						cut.Store(true)
						switch mode {
						case proxyDrop:
							client.Close()
							server.Close()
							return
						case proxyCut:
							server.Write(buf[:n])
							time.Sleep(300 * time.Millisecond) // let Postgres commit
							client.Close()
							server.Close()
							return
						}
					}
					server.Write(buf[:n])
				}
				if err != nil {
					server.Close()
					return
				}
			}
		}()
	}
}

// The order that makes "the server answers first" true: Postgres gives up on
// the UPDATE, then the API on the whole save, then the client.
func TestSaveDeadlineChain(t *testing.T) {
	const clientSaveTimeout = 15 * time.Second // SAVE_TIMEOUT_MS in web/src/api.ts
	if updateTimeout != 10*time.Second || saveDeadline() != 12*time.Second {
		t.Errorf("updateTimeout %v, saveDeadline %v; the documented chain is 10 s < 12 s < 15 s", updateTimeout, saveDeadline())
	}
	if !(updateTimeout < saveDeadline() && saveDeadline() < clientSaveTimeout) {
		t.Errorf("the chain must be updateTimeout < saveDeadline < the client's timeout")
	}
}

// With no connection free in the pool, a save must still end at its deadline
// with a definite "not saved" instead of waiting for ever.
func TestUpdatePersonGivesUpWaitingForAConnection(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	held, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(held.Release)

	saved := updateTimeout
	updateTimeout = 300 * time.Millisecond
	t.Cleanup(func() { updateTimeout = saved })

	start := time.Now()
	rec := doWithin(t, newServer(pool), "PATCH", "/api/people/3", `{"weeklyHours": 21}`, 5*time.Second)
	took := time.Since(start)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", rec.Code)
	}
	if took < saveDeadline()-100*time.Millisecond || took > saveDeadline()+time.Second {
		t.Errorf("answered after %v, want about the %v deadline", took, saveDeadline())
	}
	var stored float64
	if err := s.db.QueryRow(context.Background(), `SELECT weekly_hours::float8 FROM people WHERE id = 3`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 20 {
		t.Errorf("stored %v, want the seeded 20", stored)
	}
}

func TestHealthDoesNotLeakDatabaseErrors(t *testing.T) {
	s := testServer(t)
	logs := captureLog(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil).WithContext(ctx))
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if rec.Code != http.StatusServiceUnavailable || body["error"] != "database unavailable" {
		t.Errorf("got %d %v", rec.Code, body)
	}
	if !strings.Contains(logs.String(), "health:") {
		t.Errorf("the cause was not logged: %q", logs.String())
	}
}

func TestIfMatchIsReadAsInHTTP(t *testing.T) {
	for _, tc := range []struct {
		header   []string
		versions []string
		ok       bool
	}{
		{nil, nil, true},           // no header: unconditional
		{[]string{"*"}, nil, true}, // any existing row
		{[]string{`"812"`}, []string{"812"}, true},
		{[]string{`W/"812"`}, []string{"812"}, true},
		{[]string{` "812" `}, []string{"812"}, true},
		{[]string{`"999", "812"`}, []string{"999", "812"}, true},   // a list: any may match
		{[]string{`"999"`, `"812"`}, []string{"999", "812"}, true}, // over several lines
		{[]string{`""`}, nil, false},                               // an empty version must not mean "unconditional"
		{[]string{`" "`}, nil, false},
		{[]string{`812`}, nil, false}, // not a quoted tag
		{[]string{``}, nil, false},
	} {
		versions, ok := parseIfMatch(tc.header)
		if !reflect.DeepEqual(versions, tc.versions) || ok != tc.ok {
			t.Errorf("If-Match %q: got (%q, %v), want (%q, %v)", tc.header, versions, ok, tc.versions, tc.ok)
		}
	}
}

func TestIfMatchListMatchesAnyVersion(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	req := httptest.NewRequest("PATCH", "/api/people/3", strings.NewReader(`{"weeklyHours": 22}`))
	req.Header.Set("If-Match", `"999999999", "`+versionOf(t, s, 3)+`"`)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status %d %s, want 200: one tag in the list is the current version", rec.Code, rec.Body)
	}
}

// The client always sends If-Match, so an unknown person must come back as
// 404 on that path too, not as a "changed" row.
func TestUnknownPersonIsNotFoundWithIfMatch(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	if rec := patchIfMatch(t, s, "999999", "1", `{"weeklyHours": 10}`); rec.Code != http.StatusNotFound {
		t.Errorf("status %d %s, want 404", rec.Code, rec.Body)
	}
	req := httptest.NewRequest("PATCH", "/api/people/3", strings.NewReader(`{"weeklyHours": 21}`))
	req.Header.Set("If-Match", `""`)
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty If-Match: status %d, want 400", rec.Code)
	}
	if h := storedHours(t, s, 3); h != 20 {
		t.Errorf("stored %v, want the seeded 20", h)
	}
}

// The version check and the write must be one atomic step. Here a second
// manager's UPDATE holds the row (not yet committed); our save, on the version
// both read, waits behind it. When theirs commits, ours must get 412 and their
// value must stand. A read-then-write check would see the old version, then
// overwrite theirs.
func TestConcurrentSaveOnTheSameVersionLosesNothing(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	restoreCem(t, s)
	v := versionOf(t, s, 3)

	other, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Rollback(ctx)
	if _, err := other.Exec(ctx, `UPDATE people SET weekly_hours = 28 WHERE id = 3`); err != nil {
		t.Fatal(err)
	}

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- patchIfMatch(t, s, "3", v, `{"weeklyHours": 26}`) }()
	waitUntilBlockedOnALock(t, s)
	if err := other.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	select {
	case rec := <-done:
		if rec.Code != http.StatusPreconditionFailed {
			t.Errorf("status %d %s, want 412: the row changed while we waited", rec.Code, rec.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("our save never finished")
	}
	if h := storedHours(t, s, 3); h != 28 {
		t.Errorf("stored %v, want the other manager's 28: an update was lost", h)
	}
}

// waitUntilBlockedOnALock returns once a session is waiting for a row lock, so
// a test can release the lock knowing the other side is already queued behind
// it, rather than hoping a sleep was long enough.
func waitUntilBlockedOnALock(t *testing.T, s *server) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := s.db.QueryRow(context.Background(), `
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no session ever waited for the row lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A body is read up to 1 KiB: anything longer is refused before it reaches
// the database. (Whitespace is valid JSON, so without the limit this body
// would be decoded and the unknown person looked up.)
func TestUpdatePersonRefusesAnOversizedBody(t *testing.T) {
	s := testServer(t)
	body := `{"weeklyHours": 20` + strings.Repeat(" ", 2000) + `}`
	if rec := do(t, s, "PATCH", "/api/people/2147483647", body); rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400 for a 2 KB body", rec.Code)
	}
}

// statement_timeout is set for the save's transaction only. Set for the
// session, it would stay on the pooled connection and cut off whatever query
// ran on it next.
func TestSaveTimeoutStaysInItsTransaction(t *testing.T) {
	s := testServer(t)
	restoreCem(t, s)
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1 // so the check runs on the connection the save used
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	show := func() string {
		var v string
		if err := pool.QueryRow(context.Background(), `SHOW statement_timeout`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	before := show()
	if rec := do(t, newServer(pool), "PATCH", "/api/people/3", `{"weeklyHours": 21}`); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if after := show(); after != before {
		t.Errorf("statement_timeout is %q after a save, was %q: it leaked out of the save's transaction", after, before)
	}
}

// Every answer is JSON, and says so: the client parses errors and successes
// the same way.
func TestAnswersAreJSON(t *testing.T) {
	s := testServer(t)
	for _, url := range []string{"/api/health", "/api/capacity?from=2026-01-05&to=2026-01-11", "/api/capacity?from=nope"} {
		if ct := do(t, s, "GET", url, "").Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: Content-Type %q", url, ct)
		}
	}
}

func TestHealthCountsPeople(t *testing.T) {
	s := testServer(t)
	var body struct {
		OK     bool `json:"ok"`
		People int  `json:"people"`
	}
	if err := json.NewDecoder(do(t, s, "GET", "/api/health", "").Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.People != 500 {
		t.Errorf("got %+v, want ok with the 500 seeded people", body)
	}
}
