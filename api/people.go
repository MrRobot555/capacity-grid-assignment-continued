package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// maxWeeklyHours is every hour of a week. Anything above it is a typo, not a
// contract.
const maxWeeklyHours = 168

// updateTimeout bounds how long a save's UPDATE may take in the database, e.g.
// waiting behind a row lock held elsewhere. The whole save gets 2 s more, and
// the client waits longer still (SAVE_TIMEOUT_MS in web/src/api.ts), so the
// server's definite "not saved" arrives before the client gives up.
var updateTimeout = 10 * time.Second

// saveDeadline bounds the whole save, including waiting for a pooled
// connection and the COMMIT. The chain, so the server always answers before
// the client gives up: Postgres 10 s < API 12 s < client 15 s
// (SAVE_TIMEOUT_MS in web/src/api.ts).
func saveDeadline() time.Duration { return updateTimeout + 2*time.Second }

// errOutcomeUnknown marks a save whose COMMIT got no answer: the connection
// failed after the COMMIT may have reached Postgres, so the value may or may
// not be stored. The client must not be told "not saved".
var errOutcomeUnknown = errors.New("the save may or may not have been stored")

type person struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	WeeklyHours float64 `json:"weeklyHours"`
}

// handleUpdatePerson serves PATCH /api/people/{id} with {"weeklyHours": n}.
//
// It returns the person as stored, so the client can update its state from the
// server's value instead of from what it sent.
func (s *server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	// people.id is an int4: anything larger can't exist and would fail in Postgres.
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 32)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "id must be a positive integer")
		return
	}

	var body struct {
		WeeklyHours *float64 `json:"weeklyHours"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, `body must be {"weeklyHours": number}`)
		return
	}
	// Decode stops after the first value; anything after it is a malformed body.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, `body must be {"weeklyHours": number}`)
		return
	}
	if body.WeeklyHours == nil {
		writeError(w, http.StatusBadRequest, "weeklyHours is required")
		return
	}
	hours := *body.WeeklyHours
	if hours < 0 || hours > maxWeeklyHours {
		writeError(w, http.StatusBadRequest, "weeklyHours must be between 0 and 168")
		return
	}

	// A save may carry an id (Save-Id) so its outcome can be looked up later
	// if the answer is lost (saves.go). A repeated id is answered from the record.
	saveID := r.Header.Get("Save-Id")
	if saveID != "" {
		if !saveIDPattern.MatchString(saveID) {
			writeError(w, http.StatusBadRequest, "Save-Id must be 8–64 letters, digits or dashes")
			return
		}
		if prev, fresh := s.saves.begin(saveID, int(id)); !fresh {
			switch prev.State {
			case saveStored:
				writeJSON(w, http.StatusOK, prev.Person)
			case saveInProgress:
				writeError(w, http.StatusConflict, "this save is already in progress")
			default:
				writeError(w, http.StatusConflict, "this save was given up on and was not stored")
			}
			return
		}
	}

	// One deadline for the whole save, including waiting for a pooled
	// connection and the COMMIT. It is longer than the database's own limit
	// (updateTimeout), so a stuck UPDATE gets Postgres's definite answer first.
	ctx, cancel := context.WithTimeout(r.Context(), saveDeadline())
	defer cancel()
	p, err := s.updateWeeklyHours(ctx, int(id), hours)
	if err != nil {
		log.Printf("update person %d: %v", id, err)
		status, body := saveErrorResponse(err)
		if saveID != "" {
			state := saveNotStored
			if body["stored"] == "unknown" {
				state = saveUnknown
			}
			s.saves.finish(saveID, state, nil)
		}
		writeJSON(w, status, body)
		return
	}
	if saveID != "" {
		s.saves.finish(saveID, saveStored, &p)
	}
	writeJSON(w, http.StatusOK, p)
}

// updateWeeklyHours stores the value and returns the row as stored.
//
// The time limit is enforced by Postgres (statement_timeout, for this
// transaction only), not by a Go context deadline. A deadline only makes Go
// stop waiting: an UPDATE queued behind a row lock would still run and commit
// once the lock was released, after we had answered "not saved". When Postgres
// cancels the statement instead, the transaction is aborted and nothing is stored.
//
// If the answer to COMMIT is lost, the transaction's id is used to ask
// Postgres whether it committed (pg_xact_status, made for exactly this), so
// even that case usually gets a definite answer.
func (s *server) updateWeeklyHours(ctx context.Context, id int, hours float64) (person, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return person{}, err
	}
	defer tx.Rollback(ctx)

	timeout := fmt.Sprintf("%dms", updateTimeout.Milliseconds())
	var xid string
	if err := tx.QueryRow(ctx,
		`SELECT pg_current_xact_id()::text FROM set_config('statement_timeout', $1, true)`, timeout).
		Scan(&xid); err != nil {
		return person{}, err
	}
	var p person
	if err := tx.QueryRow(ctx, `
		UPDATE people SET weekly_hours = $2
		WHERE id = $1
		RETURNING id, name, weekly_hours::float8`, id, hours).
		Scan(&p.ID, &p.Name, &p.WeeklyHours); err != nil {
		return person{}, err
	}
	if err := commitOutcome(tx.Commit(ctx)); errors.Is(err, errOutcomeUnknown) {
		// The outcome is already settled by now: Commit hands the connection
		// back, and pgxpool destroys a connection that is closed, busy or still
		// in a transaction. A COMMIT that reached Postgres completes anyway; a
		// transaction it never received is aborted by the disconnect.
		return p, s.committedAfterAll(xid, err)
	} else if err != nil {
		return person{}, err
	}
	return p, nil
}

// commitOutcome tells a COMMIT that Postgres refused (an error from Postgres:
// nothing was stored) from one whose answer was lost (anything else, such as a
// dropped connection or the save's deadline: it may have been stored).
func commitOutcome(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return err
	}
	return fmt.Errorf("%w: %v", errOutcomeUnknown, err)
}

// errCommitAborted: the COMMIT's answer was lost, and Postgres says the
// transaction did not commit. A definite "not stored".
var errCommitAborted = errors.New("the transaction did not commit")

// committedAfterAll asks Postgres, on a fresh connection, what became of a
// transaction whose COMMIT got no answer. It returns nil if it committed,
// errCommitAborted if it didn't, and the original error (still unknown) if
// Postgres can't be asked.
func (s *server) committedAfterAll(xid string, lost error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var status *string
		err := s.db.QueryRow(ctx, `SELECT pg_xact_status($1::xid8)`, xid).Scan(&status)
		switch {
		case err != nil:
			return fmt.Errorf("%w (asking Postgres failed: %v)", lost, err)
		case status != nil && *status == "committed":
			return nil
		case status != nil && *status == "aborted":
			return fmt.Errorf("%w: %v", errCommitAborted, lost)
		}
		// "in progress": the COMMIT (or the abort of a dropped connection) is
		// still being processed. Ask again shortly.
		select {
		case <-ctx.Done():
			return lost
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// saveErrorResponse says what a failed save tells the client. Only "stored":
// "unknown" lets the client know the value may be stored anyway; every other
// answer means nothing was stored.
func saveErrorResponse(err error) (int, map[string]string) {
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, errOutcomeUnknown):
		return http.StatusInternalServerError, map[string]string{
			"error":  "the save couldn't be confirmed",
			"stored": "unknown",
		}
	case errors.Is(err, pgx.ErrNoRows):
		return http.StatusNotFound, map[string]string{"error": "person not found"}
	case errors.As(err, &pgErr) && pgErr.Code == "57014", // query_canceled: statement_timeout
		errors.Is(err, context.DeadlineExceeded): // e.g. no pooled connection in time; COMMIT never sent
		return http.StatusServiceUnavailable, map[string]string{"error": "the database didn't respond in time"}
	default:
		return http.StatusInternalServerError, map[string]string{"error": "could not update person"}
	}
}
