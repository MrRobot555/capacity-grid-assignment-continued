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
	"strings"
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

// staleError: the row changed since the client loaded the version it sent.
// Nothing was stored; current is the row as it is now.
type staleError struct{ current person }

func (e *staleError) Error() string { return "the row changed since that version" }

// person is a row of people. Version is the row's xmin: Postgres changes it on
// every update of the row, so it serves as a row version without a schema
// change (the scaffold's people table has no version column).
type person struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	WeeklyHours float64 `json:"weeklyHours"`
	Version     string  `json:"version"`
}

// handleUpdatePerson serves PATCH /api/people/{id} with {"weeklyHours": n}.
//
// With If-Match: "<version>" the save applies only if the row is still at that
// version; otherwise it answers 412 with the current row. That makes a save
// safe to repeat (a client that lost the answer sends the identical request
// again: it either applies, or meets the version its own first attempt, or
// someone else, produced) and stops a save made on a stale view from
// silently overwriting someone else's change.
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
	version, ok := parseIfMatch(r.Header.Values("If-Match"))
	if !ok {
		writeError(w, http.StatusBadRequest, `If-Match must be "<version>" or *`)
		return
	}

	// One deadline for the whole save, including waiting for a pooled
	// connection and the COMMIT. It is longer than the database's own limit
	// (updateTimeout), so a stuck UPDATE gets Postgres's definite answer first.
	ctx, cancel := context.WithTimeout(r.Context(), saveDeadline())
	defer cancel()
	p, err := s.updateWeeklyHours(ctx, int(id), hours, version)
	if err != nil {
		log.Printf("update person %d: %v", id, err)
		status, body := saveErrorResponse(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// updateWeeklyHours stores the value and returns the row as stored. With a
// version, it stores only if the row is still at that version.
//
// The time limit is enforced by Postgres (statement_timeout, for this
// transaction only), not by a Go context deadline. A deadline only makes Go
// stop waiting: an UPDATE queued behind a row lock would still run and commit
// once the lock was released, after we had answered "not saved". When Postgres
// cancels the statement instead, the transaction is aborted and nothing is stored.
func (s *server) updateWeeklyHours(ctx context.Context, id int, hours float64, version string) (person, error) {
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
	err = tx.QueryRow(ctx, `
		UPDATE people SET weekly_hours = $2
		WHERE id = $1 AND ($3 = '' OR xmin::text = $3)
		RETURNING id, name, weekly_hours::float8, xmin::text`, id, hours, version).
		Scan(&p.ID, &p.Name, &p.WeeklyHours, &p.Version)
	if errors.Is(err, pgx.ErrNoRows) && version != "" {
		// Either there is no such person, or the row has moved on.
		var current person
		if err := tx.QueryRow(ctx, `
			SELECT id, name, weekly_hours::float8, xmin::text FROM people WHERE id = $1`, id).
			Scan(&current.ID, &current.Name, &current.WeeklyHours, &current.Version); err != nil {
			return person{}, err
		}
		return person{}, &staleError{current: current}
	}
	if err != nil {
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
// client settles the latter by sending the identical save again: If-Match
// makes the repeat apply only if the first attempt didn't.
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
// answer means nothing was stored by this request.
func saveErrorResponse(err error) (int, map[string]any) {
	var pgErr *pgconn.PgError
	var stale *staleError
	switch {
	case errors.Is(err, errOutcomeUnknown):
		return http.StatusInternalServerError, map[string]any{
			"error":  "the save couldn't be confirmed",
			"stored": "unknown",
		}
	case errors.As(err, &stale):
		return http.StatusPreconditionFailed, map[string]any{
			"error":   "the weekly hours were changed on the server since they were loaded",
			"current": stale.current,
		}
	case errors.Is(err, pgx.ErrNoRows):
		return http.StatusNotFound, map[string]any{"error": "person not found"}
	case errors.As(err, &pgErr) && pgErr.Code == "57014", // query_canceled: statement_timeout
		errors.Is(err, context.DeadlineExceeded): // e.g. no pooled connection in time; COMMIT never sent
		return http.StatusServiceUnavailable, map[string]any{"error": "the database didn't respond in time"}
	default:
		return http.StatusInternalServerError, map[string]any{"error": "could not update person"}
	}
}

// parseIfMatch reads the version a save is conditional on. No header, or *,
// means unconditional ("" back): * matches any existing row, as in HTTP. A
// weak tag (W/"…") is compared like a strong one: a row has one version. An
// empty tag is refused, so a client that lost track of a version can't
// silently fall back to last-write-wins.
func parseIfMatch(values []string) (string, bool) {
	if len(values) == 0 {
		return "", true
	}
	tag := strings.TrimSpace(values[0])
	if tag == "*" {
		return "", true
	}
	tag = strings.TrimPrefix(tag, "W/")
	if len(tag) < 2 || !strings.HasPrefix(tag, `"`) || !strings.HasSuffix(tag, `"`) {
		return "", false
	}
	tag = strings.TrimSpace(tag[1 : len(tag)-1])
	return tag, tag != ""
}
