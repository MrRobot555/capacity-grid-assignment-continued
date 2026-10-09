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

func lookupSave(t *testing.T, s *server, saveID, instance string) saveRecord {
	t.Helper()
	rec := do(t, s, "GET", "/api/saves/"+saveID+"?instance="+instance, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup %s: status %d %s", saveID, rec.Code, rec.Body)
	}
	var out struct {
		State  saveState `json:"state"`
		Person *person   `json:"person"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return saveRecord{State: out.State, Person: out.Person}
}

func storedHours(t *testing.T, s *server, id int) float64 {
	t.Helper()
	var h float64
	if err := s.db.QueryRow(context.Background(), `SELECT weekly_hours::float8 FROM people WHERE id = $1`, id).Scan(&h); err != nil {
		t.Fatal(err)
	}
	return h
}

func TestSaveOutcomeCanBeLookedUp(t *testing.T) {
	s := testServer(t)
	t.Cleanup(func() { do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`) })

	if rec := patchWithID(t, s, "3", "save-stored-1", `{"weeklyHours": 22}`); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	got := lookupSave(t, s, "save-stored-1", s.instance)
	if got.State != saveStored || got.Person == nil || got.Person.WeeklyHours != 22 {
		t.Errorf("lookup = %+v, want stored with 22", got)
	}

	// A repeat of the same request (a retry of a lost answer, a duplicate) is
	// answered from the record and stores nothing new.
	rec := patchWithID(t, s, "3", "save-stored-1", `{"weeklyHours": 25}`)
	var p person
	_ = json.NewDecoder(rec.Body).Decode(&p)
	if rec.Code != http.StatusOK || p.WeeklyHours != 22 || storedHours(t, s, 3) != 22 {
		t.Errorf("replay: %d %+v, stored %v; want the first save's answer and nothing new stored", rec.Code, p, storedHours(t, s, 3))
	}
}

func TestSaveOutcomeOfAFailedSave(t *testing.T) {
	s := testServer(t)
	if rec := patchWithID(t, s, "999999", "save-missing-1", `{"weeklyHours": 22}`); rec.Code != http.StatusNotFound {
		t.Fatalf("status %d", rec.Code)
	}
	if got := lookupSave(t, s, "save-missing-1", s.instance); got.State != saveNotStored {
		t.Errorf("lookup = %+v, want not-stored", got)
	}
}

// A save the API never saw is fenced: "not stored" is then true for good,
// because the request is refused if it turns up later.
func TestUnseenSaveIsFenced(t *testing.T) {
	s := testServer(t)
	if got := lookupSave(t, s, "save-late-1", s.instance); got.State != saveNotStored {
		t.Fatalf("lookup = %+v, want not-stored", got)
	}
	rec := patchWithID(t, s, "3", "save-late-1", `{"weeklyHours": 23}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("a fenced save was not refused: status %d", rec.Code)
	}
	if h := storedHours(t, s, 3); h != 20 {
		t.Errorf("stored %v, want the seeded 20", h)
	}
}

// After a restart the API can't know about saves sent to the old process, so
// it says so instead of fencing (which could contradict a save that went through).
func TestSaveSentToAnotherProcessIsUnknown(t *testing.T) {
	s := testServer(t)
	if got := lookupSave(t, s, "save-old-1", "some-earlier-process"); got.State != saveUnknown {
		t.Errorf("lookup = %+v, want unknown", got)
	}
	t.Cleanup(func() { do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`) })
	if rec := patchWithID(t, s, "3", "save-old-1", `{"weeklyHours": 23}`); rec.Code != http.StatusOK {
		t.Errorf("an unknown (not fenced) id must still be accepted: status %d", rec.Code)
	}
}

// While a save waits (here behind a row lock), every client sees the person
// as "saving", and a lookup says "in-progress"; once it ends, both settle.
func TestSaveInProgressIsVisibleToEveryone(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	t.Cleanup(func() { do(t, s, "PATCH", "/api/people/3", `{"weeklyHours": 20}`) })
	savedWait := lookupWait
	lookupWait = 200 * time.Millisecond
	t.Cleanup(func() { lookupWait = savedWait })

	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM people WHERE id = 3 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- patchWithID(t, s, "3", "save-waiting-1", `{"weeklyHours": 24}`) }()
	time.Sleep(200 * time.Millisecond)

	if !savingInCapacity(t, s, 3) {
		t.Error("capacity doesn't show person 3 as saving while the save waits")
	}
	if got := lookupSave(t, s, "save-waiting-1", s.instance); got.State != saveInProgress {
		t.Errorf("lookup = %+v, want in-progress", got)
	}

	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case rec := <-done:
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the save didn't finish after the lock was released")
	}
	if savingInCapacity(t, s, 3) {
		t.Error("capacity still shows person 3 as saving after the save ended")
	}
	if got := lookupSave(t, s, "save-waiting-1", s.instance); got.State != saveStored {
		t.Errorf("lookup = %+v, want stored", got)
	}
}

func savingInCapacity(t *testing.T, s *server, id int) bool {
	t.Helper()
	rec := do(t, s, "GET", "/api/capacity?from=2026-01-05&to=2026-01-11", "")
	var resp capacityResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	for _, p := range resp.People {
		if p.ID == id {
			return p.Saving
		}
	}
	t.Fatalf("person %d not in the response", id)
	return false
}

func TestSaveIDsAreChecked(t *testing.T) {
	s := testServer(t)
	for _, bad := range []string{"short", strings.Repeat("a", 65), "has space here", "semi;colon-id"} {
		if rec := patchWithID(t, s, "3", bad, `{"weeklyHours": 20}`); rec.Code != http.StatusBadRequest {
			t.Errorf("Save-Id %q: status %d, want 400", bad, rec.Code)
		}
	}
}

func TestEveryResponseNamesTheProcess(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, "GET", "/api/health", "")
	if got := rec.Header().Get("Server-Instance"); got == "" || got != s.instance {
		t.Errorf("Server-Instance = %q, want %q", got, s.instance)
	}
}
