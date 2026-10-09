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

// updateTimeout bounds how long a save may take in the database, e.g. waiting
// behind a row lock held elsewhere. The client waits longer (SAVE_TIMEOUT_MS in web/src/api.ts),
// so when the server gives up first the manager gets a definite "not saved".
var updateTimeout = 10 * time.Second

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

	p, err := s.updateWeeklyHours(r.Context(), int(id), hours)
	var pgErr *pgconn.PgError
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "person not found")
		return
	}
	if errors.Is(err, errOutcomeUnknown) {
		log.Printf("update person %d: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":  "the save couldn't be confirmed",
			"stored": "unknown",
		})
		return
	}
	if errors.As(err, &pgErr) && pgErr.Code == "57014" { // query_canceled: statement_timeout
		log.Printf("update person %d: gave up after %v: %v", id, updateTimeout, err)
		writeError(w, http.StatusServiceUnavailable, "the database didn't respond in time")
		return
	}
	if err != nil {
		log.Printf("update person %d: %v", id, err)
		writeError(w, http.StatusInternalServerError, "could not update person")
		return
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
	return p, commitOutcome(tx.Commit(ctx))
}

// commitOutcome tells a COMMIT that Postgres refused (an error from Postgres:
// nothing was stored) from one whose answer was lost (anything else, such as a
// dropped connection: it may have been stored).
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
