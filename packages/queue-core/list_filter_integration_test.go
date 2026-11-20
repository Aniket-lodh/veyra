//go:build integration

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

	// Fixture: handler × queue grid.
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

	// listHandlers returns the handler of every row List yields for p, and asserts Count agrees with the number of rows List returned (the two…
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

func TestList_WorkerFilter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	const workerA = "01TESTWORKERA00000000000001"
	const workerB = "01TESTWORKERB00000000000001"
	const q = "worker-filter-q"
	const h = "worker-filter-h"

	// 1. Job 1: Running on workerA
	j1, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTWORKERJOB000000000001",
		Handler:     h,
		Queue:       q,
		MaxAttempts: 3,
		Backoff:     queuecore.DefaultBackoff(),
		Payload:     json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create j1: %v", err)
	}
	claimed1, err := repo.ClaimNextJob(ctx, workerA, []string{q}, []string{h})
	if err != nil || claimed1 == nil || claimed1.ID != j1.ID {
		t.Fatalf("claim j1: %v", err)
	}

	// 2. Job 2: Claimed by workerA, then succeeded
	j2, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTWORKERJOB000000000002",
		Handler:     h,
		Queue:       q,
		MaxAttempts: 3,
		Backoff:     queuecore.DefaultBackoff(),
		Payload:     json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create j2: %v", err)
	}
	claimed2, err := repo.ClaimNextJob(ctx, workerA, []string{q}, []string{h})
	if err != nil || claimed2 == nil || claimed2.ID != j2.ID {
		t.Fatalf("claim j2: %v", err)
	}
	_, err = repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: workerA,
		JobID:    j2.ID,
		Result:   json.RawMessage(`{"done":true}`),
	})
	if err != nil {
		t.Fatalf("succeed j2: %v", err)
	}

	// 3. Job 3: Claimed by workerB, then succeeded
	j3, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTWORKERJOB000000000003",
		Handler:     h,
		Queue:       q,
		MaxAttempts: 3,
		Backoff:     queuecore.DefaultBackoff(),
		Payload:     json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create j3: %v", err)
	}
	claimed3, err := repo.ClaimNextJob(ctx, workerB, []string{q}, []string{h})
	if err != nil || claimed3 == nil || claimed3.ID != j3.ID {
		t.Fatalf("claim j3: %v", err)
	}
	_, err = repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: workerB,
		JobID:    j3.ID,
		Result:   json.RawMessage(`{"done":true}`),
	})
	if err != nil {
		t.Fatalf("succeed j3: %v", err)
	}

	// 4. Job 4: Fresh queued, never claimed
	_, err = repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTWORKERJOB000000000004",
		Handler:     h,
		Queue:       q,
		MaxAttempts: 3,
		Backoff:     queuecore.DefaultBackoff(),
		Payload:     json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create j4: %v", err)
	}

	// Subtest A: Filter by workerA (matches running Job 1 and completed Job 2)
	t.Run("matches active and historical attempts for workerA", func(t *testing.T) {
		p := queuecore.ListParams{WorkerID: workerA, Limit: 50}
		jobs, err := repo.List(ctx, p)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		count, err := repo.Count(ctx, p)
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != 2 || len(jobs) != 2 {
			t.Fatalf("want 2 jobs for workerA, got count=%d len=%d", count, len(jobs))
		}
		ids := map[string]bool{jobs[0].ID: true, jobs[1].ID: true}
		if !ids[j1.ID] || !ids[j2.ID] {
			t.Fatalf("expected jobs %s and %s, got: %v, %v", j1.ID, j2.ID, jobs[0].ID, jobs[1].ID)
		}
	})

	// Subtest B: Filter by workerB (matches historical completed Job 3)
	t.Run("matches historical attempt for workerB", func(t *testing.T) {
		p := queuecore.ListParams{WorkerID: workerB, Limit: 50}
		jobs, err := repo.List(ctx, p)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		count, err := repo.Count(ctx, p)
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != 1 || len(jobs) != 1 || jobs[0].ID != j3.ID {
			t.Fatalf("want 1 job (%s) for workerB, got count=%d jobs=%v", j3.ID, count, jobs)
		}
	})

	// Subtest C: Unknown worker ID returns empty cleanly
	t.Run("non-matching worker returns empty cleanly", func(t *testing.T) {
		p := queuecore.ListParams{WorkerID: "01TESTWORKERUNKNOWN00000001", Limit: 50}
		jobs, err := repo.List(ctx, p)
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		count, err := repo.Count(ctx, p)
		if err != nil {
			t.Fatalf("Count: %v", err)
		}
		if count != 0 || len(jobs) != 0 {
			t.Fatalf("want 0 jobs for unknown worker, got count=%d len=%d", count, len(jobs))
		}
	})

	// Subtest D: Composed with status filter
	t.Run("AND-composed with status filter", func(t *testing.T) {
		runningP := queuecore.ListParams{
			WorkerID: workerA,
			Statuses: []queuecore.JobStatus{queuecore.StatusRunning},
			Limit:    50,
		}
		runningJobs, err := repo.List(ctx, runningP)
		if err != nil {
			t.Fatalf("List running: %v", err)
		}
		if len(runningJobs) != 1 || runningJobs[0].ID != j1.ID {
			t.Fatalf("want running job %s for workerA, got %v", j1.ID, runningJobs)
		}

		succeededP := queuecore.ListParams{
			WorkerID: workerA,
			Statuses: []queuecore.JobStatus{queuecore.StatusSucceeded},
			Limit:    50,
		}
		succeededJobs, err := repo.List(ctx, succeededP)
		if err != nil {
			t.Fatalf("List succeeded: %v", err)
		}
		if len(succeededJobs) != 1 || succeededJobs[0].ID != j2.ID {
			t.Fatalf("want succeeded job %s for workerA, got %v", j2.ID, succeededJobs)
		}
	})
}
