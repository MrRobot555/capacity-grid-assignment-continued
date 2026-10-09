package main

// Saves the API remembers by id, so a client that lost an answer can send the
// same request again and get a definite one.
//
// A save sets an absolute value, so running it twice is harmless. The client
// gives each save an id (the Save-Id header) and, when it gets no definite
// answer, sends the identical request again with the same id until it does.
// The API remembers each id while its save runs and for a while after:
//
//   - stored:      a repeat is answered with the stored row; nothing runs again.
//   - in progress: a repeat is told to try again shortly (409, stored: unknown).
//   - unknown:     the save's COMMIT got no answer. A repeat runs the save
//     again; if that run fails for certain, the answer is still "unknown",
//     because the first attempt may have committed.
//   - refused:     the save failed for certain. A late duplicate (say, one a
//     proxy held on to) is refused too, so the "not saved" already given
//     stays true.
//
// An id it doesn't know just runs, which is also what happens after a restart:
// the registry lives in memory, because the schema is fixed. That is safe for
// a repeat. The one thing a restart loses is the "refused" guard against a
// late duplicate, which is a documented limitation.

import (
	"net/http"
	"regexp"
	"sync"
	"time"
)

type saveState string

const (
	saveInProgress saveState = "in-progress"
	saveStored     saveState = "stored"
	saveUnknown    saveState = "unknown"
	saveRefused    saveState = "refused"
)

type saveRecord struct {
	personID int
	hours    float64
	state    saveState
	person   person
	updated  time.Time
}

type saveRegistry struct {
	mu      sync.Mutex
	records map[string]*saveRecord
	// keep is how long a finished save is remembered. A client repeats within
	// a minute or so; an hour bounds memory with a wide margin.
	keep time.Duration
}

func newSaveRegistry() *saveRegistry {
	return &saveRegistry{records: map[string]*saveRecord{}, keep: time.Hour}
}

var saveIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// begin starts a save. A new id is recorded as in progress and begin returns
// known=false. For a known id it returns the record as it was. If that record
// was "unknown", it is marked in progress again, because the caller will run
// the save again.
func (r *saveRegistry) begin(id string, personID int, hours float64) (prev saveRecord, known bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune()
	rec, ok := r.records[id]
	if !ok {
		r.records[id] = &saveRecord{personID: personID, hours: hours, state: saveInProgress, updated: time.Now()}
		return saveRecord{}, false
	}
	prev = *rec
	if rec.state == saveUnknown && rec.personID == personID && rec.hours == hours {
		rec.state, rec.updated = saveInProgress, time.Now()
	}
	return prev, true
}

func (r *saveRegistry) finish(id string, state saveState, p person) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rec, ok := r.records[id]; ok {
		rec.state, rec.person, rec.updated = state, p, time.Now()
	}
}

func (r *saveRegistry) prune() {
	for id, rec := range r.records {
		if rec.state != saveInProgress && time.Since(rec.updated) > r.keep {
			delete(r.records, id)
		}
	}
}

// replay answers a repeat of a save the registry already knows. It returns
// false when the save must run (again).
func replay(w http.ResponseWriter, prev saveRecord, personID int, hours float64) bool {
	if prev.personID != personID || prev.hours != hours {
		writeError(w, http.StatusUnprocessableEntity, "this Save-Id was already used for a different change")
		return true
	}
	switch prev.state {
	case saveStored:
		writeJSON(w, http.StatusOK, prev.person)
	case saveInProgress:
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":  "this save is still in progress; send it again shortly",
			"stored": "unknown",
		})
	case saveRefused:
		writeError(w, http.StatusConflict, "this save was already refused and was not stored")
	default: // saveUnknown: run it again
		return false
	}
	return true
}
