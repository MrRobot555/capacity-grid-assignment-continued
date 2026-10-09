package main

// Save outcomes the API remembers, so a client that lost an answer can ask
// for it instead of guessing.
//
// The client gives every save an ID (the Save-Id header). The API records it
// when the save starts and its outcome when it ends. A client that got no
// answer asks GET /api/saves/{id}:
//
//   - stored / not-stored: the definite outcome.
//   - in-progress: still running (the lookup waits a little first).
//   - never seen: the request hasn't reached this API, and now never will be
//     acted on: the ID is fenced, so if the request turns up later it is
//     refused. "Not stored" is then true for good.
//   - unknown: only when this API has restarted since the save was sent. The
//     record was in the old process's memory.
//
// It lives in memory, not in the database: the schema is fixed. That is also
// why a restart loses it, and why the client is told "unknown" rather than a guess.

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"sync"
	"time"
)

type saveState string

const (
	saveInProgress saveState = "in-progress"
	saveStored     saveState = "stored"
	saveNotStored  saveState = "not-stored"
	saveUnknown    saveState = "unknown"
)

type saveRecord struct {
	PersonID int       `json:"-"`
	State    saveState `json:"state"`
	Person   *person   `json:"person,omitempty"`
	updated  time.Time
}

type saveRegistry struct {
	mu      sync.Mutex
	records map[string]*saveRecord
	// keep is how long an outcome is remembered. Clients ask within seconds;
	// a day is far beyond that, and bounds memory.
	keep time.Duration
}

func newSaveRegistry() *saveRegistry {
	return &saveRegistry{records: map[string]*saveRecord{}, keep: 24 * time.Hour}
}

var saveIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// begin records a new save. If the ID is already known (a duplicate request,
// or one fenced by a lookup), it returns that record and false instead.
func (r *saveRegistry) begin(id string, personID int) (saveRecord, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune()
	if rec, ok := r.records[id]; ok {
		return *rec, false
	}
	r.records[id] = &saveRecord{PersonID: personID, State: saveInProgress, updated: time.Now()}
	return saveRecord{}, true
}

func (r *saveRegistry) finish(id string, state saveState, p *person) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rec, ok := r.records[id]; ok {
		rec.State, rec.Person, rec.updated = state, p, time.Now()
	}
}

// lookup returns a save's outcome. sameProcess says whether the client sent
// the save to this process (it echoes the Server-Instance it saw). An ID this
// process never saw is fenced as not stored. That is only safe when the
// client's save was meant for this process; otherwise the answer is unknown.
func (r *saveRegistry) lookup(id string, sameProcess bool) saveRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rec, ok := r.records[id]; ok {
		return *rec
	}
	if !sameProcess {
		return saveRecord{State: saveUnknown}
	}
	r.records[id] = &saveRecord{State: saveNotStored, updated: time.Now()}
	return saveRecord{State: saveNotStored}
}

// saving returns the people with a save in progress on this process, so every
// client (other tabs, other managers) can show their capacity as unsettled.
func (r *saveRegistry) saving() map[int]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	people := map[int]bool{}
	for _, rec := range r.records {
		if rec.State == saveInProgress {
			people[rec.PersonID] = true
		}
	}
	return people
}

func (r *saveRegistry) prune() {
	for id, rec := range r.records {
		if rec.State != saveInProgress && time.Since(rec.updated) > r.keep {
			delete(r.records, id)
		}
	}
}

// lookupWait is how long a lookup of a save still in progress waits for it to
// finish before answering "in-progress". The client asks again after that.
var lookupWait = 5 * time.Second

// handleSaveOutcome serves GET /api/saves/{id}?instance=...
func (s *server) handleSaveOutcome(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !saveIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "not a save id")
		return
	}
	sameProcess := r.URL.Query().Get("instance") == s.instance
	rec := s.saves.lookup(id, sameProcess)
	for deadline := time.Now().Add(lookupWait); rec.State == saveInProgress && time.Now().Before(deadline); {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
		rec = s.saves.lookup(id, sameProcess)
	}
	writeJSON(w, http.StatusOK, rec)
}

// newInstanceID names this process, so a client can tell whether the API it
// asks is the one it saved through.
func newInstanceID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
