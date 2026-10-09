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

	// A save may carry an id (Save-Id), so that a client that lost the answer
	// can send it again and get a definite one (saves.go).
	saveID := r.Header.Get("Save-Id")
	rerunOfUnknown := false
	if saveID != "" {
		if !saveIDPattern.MatchString(saveID) {
			writeError(w, http.StatusBadRequest, "Save-Id must be 8–64 letters, digits or dashes")
			return
		}
		if prev, known := s.saves.begin(saveID, int(id), hours); known {
			if replay(w, prev, int(id), hours) {
				return
			}
			rerunOfUnknown = true
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
		if rerunOfUnknown && body["stored"] != "unknown" {
			// This run failed for certain, but an earlier one may have committed.
			status, body = http.StatusInternalServerError, map[string]string{
				"error":  "the save couldn't be confirmed",
				"stored": "unknown",
			}
		}
		if saveID != "" {
			state := saveRefused
			if body["stored"] == "unknown" {
				state = saveUnknown
			}
			s.saves.finish(saveID, state, person{})
		}
		writeJSON(w, status, body)
		return
	}
	if saveID != "" {
		s.saves.finish(saveID, saveStored, p)
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
func (s *server) updateWeeklyHours(ctx context.Context, id int, hours float64) (person, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return person{}, err
	}
	defer tx.Rollback(ctx)

	timeout := fmt.Sprintf("%dms", updateTimeout.Milliseconds())
	if _, err := tx.Exec(ctx, `SELECT set_config('statement_timeout', $1, true)`, timeout); err != nil {
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
	if err := commitOutcome(tx.Commit(ctx)); err != nil {
		return person{}, err
	}
	return p, nil
}

// commitOutcome tells a COMMIT that Postgres refused (an error from Postgres:
// nothing was stored) from one whose answer was lost (anything else, such as a
// dropped connection or the save's deadline: it may have been stored). The
// client settles the latter by sending the same save again (saves.go).
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
