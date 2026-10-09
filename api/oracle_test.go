package main

// The fixture test checks five people by hand. These tests check everyone, by
// computing the same numbers a second, independent way and comparing.
//
// capacityQuery works per week with interval arithmetic: the overlap of an
// assignment with Mon–Fri, times hours_per_day. The oracle below works per day:
// it expands every assignment into its days, drops weekends, and buckets the
// days with Postgres's own date_trunc('week'). The two share no logic, so a
// mistake in the overlap arithmetic, the week bucketing or the weekend rule
// shows up as a disagreement.

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// dbtx is what the pool and a transaction have in common, for the tests.
type dbtx interface {
	querier
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

const oracleQuery = `
SELECT a.person_id,
       date_trunc('week', day)::date AS week_start,
       SUM(a.hours_per_day)::float8
FROM assignments a
CROSS JOIN LATERAL generate_series(a.start_date::timestamp, a.end_date::timestamp, interval '1 day') AS day
WHERE extract(isodow FROM day) <= 5
  AND day >= $1::date
  AND day <  $2::date + 7
GROUP BY 1, 2`

type personWeek struct {
	person int
	week   string
}

func oracle(t *testing.T, ctx context.Context, db querier, weeks []time.Time) map[personWeek]float64 {
	t.Helper()
	rows, err := db.Query(ctx, oracleQuery, weeks[0], weeks[len(weeks)-1])
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := map[personWeek]float64{}
	for rows.Next() {
		var k personWeek
		var week time.Time
		var hours float64
		if err := rows.Scan(&k.person, &week, &hours); err != nil {
			t.Fatal(err)
		}
		k.week = week.Format(dateLayout)
		want[k] = hours
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return want
}

func assertMatchesOracle(t *testing.T, ctx context.Context, db dbtx, weeks []time.Time) []personCapacity {
	t.Helper()
	people, err := loadCapacity(ctx, db, weeks)
	if err != nil {
		t.Fatal(err)
	}
	want := oracle(t, ctx, db, weeks)

	var total int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM people`).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if len(people) != total {
		t.Errorf("got %d people, want all %d", len(people), total)
	}

	mismatches, seen := 0, 0
	for _, p := range people {
		if len(p.Allocated) != len(weeks) {
			t.Fatalf("person %d: %d values for %d weeks", p.ID, len(p.Allocated), len(weeks))
		}
		for i, wk := range weeks {
			k := personWeek{p.ID, wk.Format(dateLayout)}
			if _, ok := want[k]; ok {
				seen++
			}
			if got, exp := p.Allocated[i], want[k]; math.Abs(got-exp) > 1e-9 {
				if mismatches < 10 {
					t.Errorf("person %d (%s), week %s: query says %v, day-by-day says %v", p.ID, p.Name, k.week, got, exp)
				}
				mismatches++
			}
		}
	}
	if seen != len(want) {
		t.Errorf("oracle has %d allocated person-weeks, the query's people/weeks cover %d", len(want), seen)
	}
	if mismatches > 0 {
		t.Errorf("%d person-weeks disagree", mismatches)
	}
	return people
}

func mustDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse(dateLayout, s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestCapacityMatchesDayByDayOracle(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	for _, r := range []struct{ name, from, to string }{
		{"all seeded data", "2025-06-02", "2027-01-03"},
		{"mid-week to Sunday", "2025-12-31", "2026-01-11"},
		{"one week", "2026-10-07", "2026-10-07"},
		{"largest allowed range", "2025-05-26", "2027-06-06"},
		{"no data at all", "2030-01-01", "2030-02-01"},
	} {
		t.Run(r.name, func(t *testing.T) {
			weeks := weekStarts(mustDate(t, r.from), mustDate(t, r.to))
			if len(weeks) > maxWeeks {
				t.Fatalf("%d weeks: the case itself is out of range", len(weeks))
			}
			assertMatchesOracle(t, ctx, s.db, weeks)
		})
	}
}

// Shapes of assignment the seed doesn't contain, inserted in a transaction that
// is rolled back, so the seeded data is never changed.
func TestCapacitySyntheticEdgeCases(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	var edge, idle int
	if err := tx.QueryRow(ctx, `INSERT INTO people (name, weekly_hours) VALUES ('Zz Edge', 40) RETURNING id`).Scan(&edge); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `INSERT INTO people (name, weekly_hours) VALUES ('Zz Idle', 0) RETURNING id`).Scan(&idle); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO assignments (person_id, project_id, start_date, end_date, hours_per_day) VALUES
		  ($1, 1, '2026-01-10', '2026-01-11', 8),   -- Sat–Sun only: no working days
		  ($1, 1, '2026-01-14', '2026-01-27', 1),   -- Wed → Tue two weeks later: 3 + 5 + 2 days
		  ($1, 1, '2025-12-26', '2026-01-02', 2),   -- Fri → Fri across the new year: 1 + 5 days
		  ($1, 1, '2026-01-16', '2026-01-12', 8),   -- ends before it starts: contributes nothing
		  ($1, 1, '2025-01-01', '2027-12-31', 0.5)  -- longer than the range on both sides
	`, edge); err != nil {
		t.Fatal(err)
	}

	weeks := weekStarts(mustDate(t, "2025-12-22"), mustDate(t, "2026-01-31"))
	people := assertMatchesOracle(t, ctx, tx, weeks)

	want := map[int][]float64{
		//     22 Dec    29 Dec     5 Jan  12 Jan     19 Jan     26 Jan
		edge: {2 + 2.5, 10 + 2.5, 2.5, 3 + 2.5, 5 + 2.5, 2 + 2.5},
		idle: {0, 0, 0, 0, 0, 0},
	}
	for _, p := range people {
		if w, ok := want[p.ID]; ok {
			for i := range w {
				if p.Allocated[i] != w[i] {
					t.Errorf("%s, week %s: got %v, want %v", p.Name, weeks[i].Format(dateLayout), p.Allocated[i], w[i])
				}
			}
		}
	}
}

// Two plan regressions have hit this query already, both invisible to the
// correctness tests: generate_series made the planner overestimate and turn on
// JIT (~370 ms of compile time per request), and a column-to-column filter made
// it underestimate and pick a 13M-comparison nested loop. This checks the
// plan's causes (JIT) and its cost (execution time, with a wide margin: about
// 0.2 s today) for the largest request the API allows.
func TestCapacityQueryPlanStaysCheap(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	weeks := weekStarts(mustDate(t, "2025-06-02"), mustDate(t, "2027-06-13"))
	if len(weeks) != maxWeeks {
		t.Fatalf("want the largest range, got %d weeks", len(weeks))
	}
	var plan []struct {
		ExecutionTime float64        `json:"Execution Time"`
		JIT           map[string]any `json:"JIT"`
	}
	if err := s.db.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+capacityQuery, weeks).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	if plan[0].JIT != nil {
		t.Errorf("the planner turned on JIT: %v", plan[0].JIT)
	}
	if plan[0].ExecutionTime > 750 {
		t.Errorf("execution took %.0f ms for %d weeks", plan[0].ExecutionTime, len(weeks))
	}
}
