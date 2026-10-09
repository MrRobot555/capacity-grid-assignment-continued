package main

// Integration tests against the seeded database. They need DATABASE_URL and
// skip without it. Run them inside Compose:
//
//	docker compose run --rm -v ./api:/src api go test ./...

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

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
	return &server{db: db}
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

func TestUpdatePerson(t *testing.T) {
	s := testServer(t)
	// Cem (id 3) is restored afterwards so the fixture test stays valid.
	t.Cleanup(func() {
		do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`)
	})

	rec := do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 32.5}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var p person
	if err := json.NewDecoder(rec.Body).Decode(&p); err != nil {
		t.Fatal(err)
	}
	if p != (person{ID: 3, Name: "Cem Aydin", WeeklyHours: 32.5}) {
		t.Errorf("got %+v", p)
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
	var stored float64
	if err := s.db.QueryRow(ctx, `SELECT weekly_hours::float8 FROM people WHERE id = 3`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 20 {
		t.Errorf("stored weekly_hours = %v, want the seeded 20", stored)
	}
}
