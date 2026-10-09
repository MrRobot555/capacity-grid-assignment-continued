package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func patchWithID(t *testing.T, s *server, id, saveID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/api/people/"+id, strings.NewReader(body))
	req.Header.Set("Save-Id", saveID)
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

// A repeat of a stored save gets the stored row, and runs nothing again: if
// another change came in between, a repeat must not undo it.
func TestRepeatOfAStoredSaveIsAnsweredFromTheRecord(t *testing.T) {
	s := testServer(t)
	t.Cleanup(func() { do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`) })

	if rec := patchWithID(t, s, "3", "save-stored-1", `{"weeklyHours": 22}`); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 30}`) // someone else's change

	rec := patchWithID(t, s, "3", "save-stored-1", `{"weeklyHours": 22}`)
	body := decodeBody(t, rec)
	if rec.Code != http.StatusOK || body["weeklyHours"] != 22.0 {
		t.Errorf("repeat: %d %v, want 200 with the stored 22", rec.Code, body)
	}
	if h := storedHours(t, s, 3); h != 30 {
		t.Errorf("stored %v: the repeat ran again and undid a later change (want 30)", h)
	}
}

func TestSaveIDCannotBeReusedForAnotherChange(t *testing.T) {
	s := testServer(t)
	// Restore both people this test could touch, so even a broken build of the
	// API (a mutant that lets the reuse through) leaves the seed intact.
	t.Cleanup(func() {
		do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`)
		do(t, s, "PATCH", "/api/people/10", `{"weeklyHours": 40}`)
	})
	patchWithID(t, s, "3", "save-reuse-1", `{"weeklyHours": 22}`)
	for _, tc := range []struct{ id, body string }{
		{"3", `{"weeklyHours": 25}`},  // another value
		{"10", `{"weeklyHours": 22}`}, // another person
	} {
		if rec := patchWithID(t, s, tc.id, "save-reuse-1", tc.body); rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("person %s %s: status %d, want 422", tc.id, tc.body, rec.Code)
		}
	}
	if h := storedHours(t, s, 3); h != 22 {
		t.Errorf("stored %v, want 22", h)
	}
}

// A save that was refused stays refused: a late duplicate of it (say, one a
// proxy held on to) must not be stored after the client was told "not saved".
func TestLateDuplicateOfARefusedSaveIsRefused(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	saved := updateTimeout
	updateTimeout = 200 * time.Millisecond
	t.Cleanup(func() { updateTimeout = saved })

	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM people WHERE id = 3 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	first := patchWithID(t, s, "3", "save-refused-1", `{"weeklyHours": 27}`)
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if first.Code != http.StatusServiceUnavailable || decodeBody(t, first)["stored"] != nil {
		t.Fatalf("first: %d, want a definite 503", first.Code)
	}

	late := patchWithID(t, s, "3", "save-refused-1", `{"weeklyHours": 27}`)
	if late.Code != http.StatusConflict {
		t.Errorf("late duplicate: status %d, want 409", late.Code)
	}
	if h := storedHours(t, s, 3); h != 20 {
		t.Errorf("stored %v, want the seeded 20", h)
	}
}

// While a save runs, a repeat of it is told to try again: it must not run the
// save a second time in parallel.
func TestRepeatWhileInProgressDoesNotRunTwice(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	t.Cleanup(func() { do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`) })

	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM people WHERE id = 3 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- patchWithID(t, s, "3", "save-twice-1", `{"weeklyHours": 24}`) }()
	time.Sleep(200 * time.Millisecond)

	repeat := patchWithID(t, s, "3", "save-twice-1", `{"weeklyHours": 24}`)
	if body := decodeBody(t, repeat); repeat.Code != http.StatusConflict || body["stored"] != "unknown" {
		t.Errorf("repeat while running: %d %v, want 409 with stored: unknown", repeat.Code, body)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case rec := <-done:
		if rec.Code != http.StatusOK {
			t.Fatalf("first: status %d", rec.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the save didn't finish after the lock was released")
	}
	if h := storedHours(t, s, 3); h != 24 {
		t.Errorf("stored %v, want 24", h)
	}
}

// After an "unknown" outcome, a repeat runs again. If that run fails for
// certain, the answer must still be "unknown": the first attempt may have
// committed.
func TestRerunAfterUnknownNeverSaysNotStored(t *testing.T) {
	s := testServer(t)
	s.saves.records["save-rerun-1"] = &saveRecord{personID: 999999, hours: 10, state: saveUnknown, updated: time.Now()}
	rec := patchWithID(t, s, "999999", "save-rerun-1", `{"weeklyHours": 10}`)
	if body := decodeBody(t, rec); body["stored"] != "unknown" {
		t.Errorf("got %d %v, want stored: unknown", rec.Code, body)
	}
}

func TestFinishedSavesAreForgottenAfterAWhile(t *testing.T) {
	r := newSaveRegistry()
	r.keep = time.Millisecond
	r.begin("save-old-1", 3, 20)
	r.finish("save-old-1", saveStored, person{ID: 3})
	r.begin("save-running-1", 4, 40) // in progress: never pruned
	time.Sleep(5 * time.Millisecond)
	r.begin("save-new-1", 1, 40) // pruning happens on begin
	if _, ok := r.records["save-old-1"]; ok {
		t.Error("a finished save was not forgotten")
	}
	if _, ok := r.records["save-running-1"]; !ok {
		t.Error("a save in progress was forgotten")
	}
}

func TestSaveIDsAreChecked(t *testing.T) {
	s := testServer(t)
	for _, bad := range []string{"short", strings.Repeat("a", 65), "has space here", "semi;colon-id"} {
		if rec := patchWithID(t, s, "3", bad, `{"weeklyHours": 20}`); rec.Code != http.StatusBadRequest {
			t.Errorf("Save-Id %q: status %d, want 400", bad, rec.Code)
		}
	}
}
