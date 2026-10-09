package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// maxWeeklyHours is every hour of a week. Anything above it is a typo, not a
// contract.
const maxWeeklyHours = 168

// updateTimeout bounds how long a save waits on the database, e.g. behind a row
// lock held elsewhere. The client waits longer (SAVE_TIMEOUT_MS in web/src/api.ts),
// so when the server gives up first the manager gets a definite "not saved".
var updateTimeout = 10 * time.Second

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

	ctx, cancel := context.WithTimeout(r.Context(), updateTimeout)
	defer cancel()

	var p person
	err = s.db.QueryRow(ctx, `
		UPDATE people SET weekly_hours = $2
		WHERE id = $1
		RETURNING id, name, weekly_hours::float8`, id, hours).
		Scan(&p.ID, &p.Name, &p.WeeklyHours)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "person not found")
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
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
