//go:build integration

package queuecore_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"
)

const (
	claimFilterQueue   = "claim-filter-test"
	claimFilterHandler = "claim.handler.a"
	claimFilterOther   = "claim.handler.b"
)

func mustCreateClaimJob(t *testing.T, ctx context.Context, repo *queuecore.Repository, id, handler string) {
	t.Helper()
	secs := 2
	_, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          id,
		Handler:     handler,
		Queue:       claimFilterQueue,
		MaxAttempts: 3,
		Backoff:     queuecore.BackoffStrategy{Kind: "fixed", Seconds: &secs},
		Payload:     json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create(%s): %v", id, err)
	}
}

// TestClaim_FiltersByHandler covers SPEC §1.2: a worker claims only jobs whose handler is in its list, even when an earlier job for another handler is visible.
func TestClaim_FiltersByHandler(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	mustCreateClaimJob(t, ctx, repo, "01TESTCLAIMFILTERA0000001", claimFilterHandler)
	mustCreateClaimJob(t, ctx, repo, "01TESTCLAIMFILTERB0000001", claimFilterOther)

	// The handler-a job is older, so a queue-only claim would return it first.
	j, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERB000000001", []string{claimFilterQueue}, []string{claimFilterOther})
	if err != nil {
		t.Fatalf("claim as handler-b worker: %v", err)
	}
	if j == nil || j.ID != "01TESTCLAIMFILTERB0000001" {
		t.Fatalf("handler-b worker claimed %v; want the handler-b job", j)
	}

	j, err = repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERB000000001", []string{claimFilterQueue}, []string{"claim.handler.unknown"})
	if err != nil {
		t.Fatalf("claim as unknown-handler worker: %v", err)
	}
	if j != nil {
		t.Fatalf("worker with no matching handler claimed %s; want nil", j.ID)
	}

	j, err = repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERA000000001", []string{claimFilterQueue}, []string{claimFilterHandler})
	if err != nil {
		t.Fatalf("claim as handler-a worker: %v", err)
	}
	if j == nil || j.ID != "01TESTCLAIMFILTERA0000001" {
		t.Fatalf("handler-a worker claimed %v; want the handler-a job", j)
	}
}

// TestClaim_RequiresQueuesAndHandlers covers SPEC §1.10: empty filters are rejected before any SQL runs.
func TestClaim_RequiresQueuesAndHandlers(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx := context.Background()

	if _, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERA000000001", []string{claimFilterQueue}, nil); err == nil {
		t.Fatal("empty handlers: want error, got nil")
	}
	if _, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERA000000001", nil, []string{claimFilterHandler}); err == nil {
		t.Fatal("empty queues: want error, got nil")
	}
}

// TestClaim_InlineReclaimRespectsHandler covers SPEC §1.1 and §5.1: an expired lease is reclaimed inline only by a worker that runs that job's handler.
func TestClaim_InlineReclaimRespectsHandler(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const jobID = "01TESTCLAIMRECLAIM00000001"
	mustCreateClaimJob(t, ctx, repo, jobID, claimFilterHandler)

	first, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERA000000001", []string{claimFilterQueue}, []string{claimFilterHandler})
	if err != nil || first == nil {
		t.Fatalf("first claim: job=%v err=%v", first, err)
	}

	// Expire the lease well past the reclaim grace window.
	if _, err := pool.Exec(ctx,
		`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, jobID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}

	other, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERB000000001", []string{claimFilterQueue}, []string{claimFilterOther})
	if err != nil {
		t.Fatalf("claim as other-handler worker: %v", err)
	}
	if other != nil {
		t.Fatalf("other-handler worker reclaimed %s; want nil", other.ID)
	}

	reclaimed, err := repo.ClaimNextJob(ctx, "01TESTCLAIMWORKERA000000002", []string{claimFilterQueue}, []string{claimFilterHandler})
	if err != nil {
		t.Fatalf("reclaim as handler-a worker: %v", err)
	}
	if reclaimed == nil || reclaimed.ID != jobID {
		t.Fatalf("handler-a worker reclaimed %v; want %s", reclaimed, jobID)
	}
}

// TestClaim_ImmediateJob covers immediate job claiming: when a job is enqueued without a schedule offset
// (or with scheduled_for in the past), an idle worker subscribed to that queue and handler claims it immediately.
func TestClaim_ImmediateJob(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const q = "immediate-claim-queue"
	const h = "immediate.handler"
	const workerID = "01TESTWORKERIMMEDIATE0001"

	// 1. Create job with nil ScheduledFor (immediate execution)
	job, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTJOBIMMEDIATE00000001",
		Handler:     h,
		Queue:       q,
		Priority:    5,
		MaxAttempts: 3,
		Backoff:     queuecore.DefaultBackoff(),
		Payload:     json.RawMessage(`{"immediate": true}`),
	})
	if err != nil {
		t.Fatalf("Create immediate job: %v", err)
	}
	if job.Status != queuecore.StatusQueued {
		t.Fatalf("expected status 'queued', got %q", job.Status)
	}
	if job.ScheduledFor.After(time.Now().UTC().Add(1 * time.Second)) {
		t.Fatalf("immediate job scheduled_for is in the future: %v", job.ScheduledFor)
	}

	// 2. An idle worker claims the job immediately
	claimed, err := repo.ClaimNextJob(ctx, workerID, []string{q}, []string{h})
	if err != nil {
		t.Fatalf("ClaimNextJob: %v", err)
	}
	if claimed == nil {
		t.Fatal("expected claimed job to be non-nil, got nil (immediate job was not claimable)")
	}
	if claimed.ID != job.ID {
		t.Fatalf("claimed ID = %s, want %s", claimed.ID, job.ID)
	}
	if claimed.Status != queuecore.StatusRunning {
		t.Fatalf("claimed Status = %s, want running", claimed.Status)
	}
	if claimed.Attempt != 1 {
		t.Fatalf("claimed Attempt = %d, want 1", claimed.Attempt)
	}
	if claimed.CurrentWorkerID == nil || *claimed.CurrentWorkerID != workerID {
		t.Fatalf("claimed CurrentWorkerID = %v, want %s", claimed.CurrentWorkerID, workerID)
	}
	if claimed.LeaseExpiresAt == nil || !claimed.LeaseExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("claimed LeaseExpiresAt = %v, want future", claimed.LeaseExpiresAt)
	}

	// 3. Verify future-scheduled job is NOT claimable immediately
	futureTime := time.Now().UTC().Add(10 * time.Minute)
	_, err = repo.Create(ctx, queuecore.CreateParams{
		ID:           "01TESTJOBFUTURE000000000001",
		Handler:      h,
		Queue:        q,
		Priority:     5,
		MaxAttempts:  3,
		Backoff:      queuecore.DefaultBackoff(),
		Payload:      json.RawMessage(`{"immediate": false}`),
		ScheduledFor: &futureTime,
	})
	if err != nil {
		t.Fatalf("Create future job: %v", err)
	}

	secondClaim, err := repo.ClaimNextJob(ctx, workerID, []string{q}, []string{h})
	if err != nil {
		t.Fatalf("ClaimNextJob for future job: %v", err)
	}
	if secondClaim != nil {
		t.Fatalf("expected nil for future job claim, got %s", secondClaim.ID)
	}
}
