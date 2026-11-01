//go:build integration

// Exercises the ListParams.Handlers filter end-to-end against a real
// Postgres. Build-tagged so `go test ./...` skips it; run with:
//
//	go test -tags integration ./...
//
// The handler filter is observability-only (W4): it narrows the jobs
// list by exact handler name so an operator can isolate one workload
// (e.g. ?handler=http_request). It is NOT a queue semantic — it does
// not touch enqueue/dequeue/lease/retry. These assertions pin the
// contract the API + frontend rely on: exact match (not prefix),
// repeatable values OR'd together, AND-composed with other filters,
// and List/Count never disagreeing on what they match.

package queuecore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"
)

func TestList_HandlerFilter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	// Fixture: handler × queue grid. The "http_request_v2" rows exist
	// solely to prove the filter is EXACT — a ?handler=http_request must
	// not catch them the way the prefix `search` would.
	fixtures := []struct {
		handler string
		queue   string
	}{
		{"http_request", "alpha"},
		{"http_request", "alpha"},
		{"http_request", "beta"},
		{"noop", "alpha"},
		{"noop", "beta"},
		{"http_request_v2", "alpha"},
	}
	for i, f := range fixtures {
		_, err := repo.Create(ctx, queuecore.CreateParams{
			ID:          fmt.Sprintf("01TESTLISTFILTER00000000%04d", i+1),
			Handler:     f.handler,
			Queue:       f.queue,
			MaxAttempts: 3,
			Backoff:     queuecore.DefaultBackoff(),
			Payload:     json.RawMessage(`{}`),
		})
		if err != nil {
			t.Fatalf("create fixture %d (%s/%s): %v", i, f.handler, f.queue, err)
		}
	}

	// listHandlers returns the handler of every row List yields for p, and
	// asserts Count agrees with the number of rows List returned (the two
	// share buildListFilters and must never drift).
	listHandlers := func(t *testing.T, p queuecore.ListParams) []string {
		t.Helper()
		p.Limit = 100
		jobs, err := repo.List(ctx, p)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		count, err := repo.Count(ctx, p)
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != len(jobs) {
			t.Errorf("Count=%d but List returned %d rows — filters drifted", count, len(jobs))
		}
		out := make([]string, len(jobs))
		for i, j := range jobs {
			out[i] = j.Handler
		}
		return out
	}

	t.Run("exact match, not prefix", func(t *testing.T) {
		got := listHandlers(t, queuecore.ListParams{Handlers: []string{"http_request"}})
		if len(got) != 3 {
			t.Fatalf("want 3 http_request rows, got %d (%v) — exact match must exclude http_request_v2", len(got), got)
		}
		for _, h := range got {
			if h != "http_request" {
				t.Errorf("filter leaked a non-matching handler: %q", h)
			}
		}
	})

	t.Run("repeated values are OR'd", func(t *testing.T) {
		got := listHandlers(t, queuecore.ListParams{Handlers: []string{"http_request", "noop"}})
		if len(got) != 5 {
			t.Fatalf("want 5 rows (3 http_request + 2 noop), got %d (%v)", len(got), got)
		}
		for _, h := range got {
			if h != "http_request" && h != "noop" {
				t.Errorf("OR filter leaked handler %q", h)
			}
		}
	})

	t.Run("AND-composed with queue filter", func(t *testing.T) {
		got := listHandlers(t, queuecore.ListParams{
			Handlers: []string{"http_request"},
			Queues:   []string{"alpha"},
		})
		if len(got) != 2 {
			t.Fatalf("want 2 (http_request in alpha), got %d (%v) — handler+queue must AND", len(got), got)
		}
	})

	t.Run("empty handlers = no filter", func(t *testing.T) {
		got := listHandlers(t, queuecore.ListParams{})
		if len(got) != len(fixtures) {
			t.Fatalf("want all %d rows with empty filter, got %d", len(fixtures), len(got))
		}
	})

	t.Run("unknown handler matches nothing", func(t *testing.T) {
		got := listHandlers(t, queuecore.ListParams{Handlers: []string{"does_not_exist"}})
		if len(got) != 0 {
			t.Fatalf("want 0 rows for unknown handler, got %d (%v)", len(got), got)
		}
	})
}
