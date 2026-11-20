//go:build integration

package queuecore_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"
)

const (
	retryTestWorker  = "01TESTRETRYWORKER00000000001"
	retryTestQueue   = "retry-test"
	retryTestHandler = "test.retry.handler"
)

func ptrInt(v int) *int {
	return &v
}

func mustCreateRetryJobInQueue(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string, queue string, maxAttempts int) *queuecore.Job {
	t.Helper()
	job, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          id,
		Handler:     retryTestHandler,
		Queue:       queue,
		Priority:    5,
		MaxAttempts: maxAttempts,
		Backoff: queuecore.BackoffStrategy{
			Kind:        "exponential",
			BaseSeconds: ptrInt(1),
			CapSeconds:  ptrInt(10),
		},
		Payload: json.RawMessage(`{"retry": true}`),
	})
	if err != nil {
		t.Fatalf("Create(%s): %v", id, err)
	}
	return job
}

func mustCreateRetryJob(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string, maxAttempts int) *queuecore.Job {
	return mustCreateRetryJobInQueue(t, ctx, repo, id, retryTestQueue, maxAttempts)
}

func mustClaimRetryInQueue(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string, queue string) *queuecore.Job {
	t.Helper()
	claimed, err := repo.ClaimNextJob(ctx, retryTestWorker, []string{queue}, []string{retryTestHandler})
	if err != nil {
		t.Fatalf("ClaimNextJob for %s: %v", id, err)
	}
	if claimed == nil {
		t.Fatalf("ClaimNextJob: got nil, want %s", id)
	}
	if claimed.ID != id {
		t.Fatalf("ClaimNextJob: got %s, want %s", claimed.ID, id)
	}
	return claimed
}

func mustClaimRetry(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string) *queuecore.Job {
	return mustClaimRetryInQueue(t, ctx, repo, id, retryTestQueue)
}

// TestRetry_Failed covers SPEC §8.1: failed -> queued.
func TestRetry_Failed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTRETRYFAILED000000000001"
	mustCreateRetryJob(t, ctx, repo, jobID, 3)
	mustClaimRetry(t, ctx, repo, jobID)

	_, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: retryTestWorker,
		JobID:    jobID,
		Error: queuecore.JobError{
			Class:   "test_err",
			Message: "transient error",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}

	retried, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}

	if retried.Status != queuecore.StatusQueued {
		t.Fatalf("status = %s; want queued", retried.Status)
	}
	if retried.Attempt != 0 {
		t.Fatalf("attempt = %d; want 0", retried.Attempt)
	}
	if retried.Error != nil {
		t.Fatalf("error = %v; want nil", retried.Error)
	}
	if retried.NextRetryAt != nil {
		t.Fatalf("next_retry_at = %v; want nil", retried.NextRetryAt)
	}
	requireJobStatus(t, ctx, pool, jobID, "queued")
}

// TestRetry_DeadLettered covers SPEC §8.1: dead_lettered -> queued.
func TestRetry_DeadLettered(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTRETRYDLQ000000000000001"
	mustCreateRetryJob(t, ctx, repo, jobID, 1)
	mustClaimRetry(t, ctx, repo, jobID)

	// MarkJobFailed with attempt 1 of 1 causes DLQ.
	dlq, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: retryTestWorker,
		JobID:    jobID,
		Error: queuecore.JobError{
			Class:   "budget_exhausted",
			Message: "terminal",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if dlq.Status != queuecore.StatusDeadLettered {
		t.Fatalf("status after fail = %s; want dead_lettered", dlq.Status)
	}

	retried, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}

	if retried.Status != queuecore.StatusQueued {
		t.Fatalf("status = %s; want queued", retried.Status)
	}
	if retried.Attempt != 0 {
		t.Fatalf("attempt = %d; want 0", retried.Attempt)
	}
	if retried.DeadLetteredAt != nil {
		t.Fatalf("dead_lettered_at = %v; want nil", retried.DeadLetteredAt)
	}
	requireJobStatus(t, ctx, pool, jobID, "queued")
}

// TestRetry_Cancelled covers SPEC §8.1: cancelled -> queued.
func TestRetry_Cancelled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTRETRYCANCEL000000000001"
	mustCreateRetryJob(t, ctx, repo, jobID, 3)

	cancelled, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if cancelled.Status != queuecore.StatusCancelled {
		t.Fatalf("status after cancel = %s; want cancelled", cancelled.Status)
	}

	retried, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}

	if retried.Status != queuecore.StatusQueued {
		t.Fatalf("status = %s; want queued", retried.Status)
	}
	if retried.Attempt != 0 {
		t.Fatalf("attempt = %d; want 0", retried.Attempt)
	}
	if retried.CancelledAt != nil {
		t.Fatalf("cancelled_at = %v; want nil", retried.CancelledAt)
	}
	requireJobStatus(t, ctx, pool, jobID, "queued")
}

// TestRetry_RejectsQueuedRunningSucceeded covers SPEC §8.1 non-retryable rejection.
func TestRetry_RejectsQueuedRunningSucceeded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	// 1. Queued
	jobID1 := "01TESTRETRYREJQUEUED000000001"
	mustCreateRetryJobInQueue(t, ctx, repo, jobID1, "retry-test-rej-queued", 3)
	if _, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID1}); !errors.Is(err, queuecore.ErrNotRetryable) {
		t.Fatalf("Retry(queued): got err %v; want ErrNotRetryable", err)
	}

	// 2. Running
	jobID2 := "01TESTRETRYREJRUNNING00000001"
	mustCreateRetryJobInQueue(t, ctx, repo, jobID2, "retry-test-rej-running", 3)
	mustClaimRetryInQueue(t, ctx, repo, jobID2, "retry-test-rej-running")
	if _, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID2}); !errors.Is(err, queuecore.ErrNotRetryable) {
		t.Fatalf("Retry(running): got err %v; want ErrNotRetryable", err)
	}

	// 3. Succeeded
	_, err := repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: retryTestWorker,
		JobID:    jobID2,
		Result:   json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("MarkJobSucceeded: %v", err)
	}
	if _, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID2}); !errors.Is(err, queuecore.ErrNotRetryable) {
		t.Fatalf("Retry(succeeded): got err %v; want ErrNotRetryable", err)
	}
}

// TestReplayDLQ covers SPEC §8.2: bulk DLQ replay with filter & limit.
func TestReplayDLQ(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	// Create 3 jobs and move to DLQ
	ids := []string{
		"01TESTREPLAYDLQ00000000000001",
		"01TESTREPLAYDLQ00000000000002",
		"01TESTREPLAYDLQ00000000000003",
	}

	for _, id := range ids {
		mustCreateRetryJob(t, ctx, repo, id, 1)
		mustClaimRetry(t, ctx, repo, id)
		_, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
			WorkerID: retryTestWorker,
			JobID:    id,
			Error: queuecore.JobError{
				Class:   "budget_exhausted",
				Message: "terminal",
			},
		})
		if err != nil {
			t.Fatalf("MarkJobFailed(%s): %v", id, err)
		}
	}

	// Replay with limit 2
	replayedIDs, err := repo.ReplayDLQ(ctx, queuecore.ReplayDLQParams{
		Queue: retryTestQueue,
		Limit: 2,
	})
	if err != nil {
		t.Fatalf("ReplayDLQ: %v", err)
	}
	if len(replayedIDs) != 2 {
		t.Fatalf("replayed count = %d; want 2", len(replayedIDs))
	}

	// Replay remainder
	replayedRemaining, err := repo.ReplayDLQ(ctx, queuecore.ReplayDLQParams{
		Queue: retryTestQueue,
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ReplayDLQ remainder: %v", err)
	}
	if len(replayedRemaining) != 1 {
		t.Fatalf("replayed remaining count = %d; want 1", len(replayedRemaining))
	}
}

// TestRetry_ClaimRetriedJob is a regression test: verifies that a retried job can be claimed
// by an idle worker without constraint violations on job_attempts (idx_job_attempts_per_job)
// or filtering issues on scheduled_for / next_retry_at / error.
func TestRetry_ClaimRetriedJob(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTRETRYCLAIM000000000001"
	mustCreateRetryJob(t, ctx, repo, jobID, 1)

	// First claim: attempt 1
	claimed1 := mustClaimRetry(t, ctx, repo, jobID)
	if claimed1.Attempt != 1 {
		t.Fatalf("first attempt = %d; want 1", claimed1.Attempt)
	}

	// Fail the job: with maxAttempts=1, this moves to dead_lettered
	dlq, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: retryTestWorker,
		JobID:    jobID,
		Error: queuecore.JobError{
			Class:   "http_500",
			Message: "internal server error",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if dlq.Status != queuecore.StatusDeadLettered {
		t.Fatalf("status after fail = %s; want dead_lettered", dlq.Status)
	}

	// Manual retry: resets to status='queued', attempt=0, cleans job_attempts
	retried, err := repo.Retry(ctx, queuecore.RetryParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if retried.Status != queuecore.StatusQueued {
		t.Fatalf("retried status = %s; want queued", retried.Status)
	}
	if retried.Attempt != 0 {
		t.Fatalf("retried attempt = %d; want 0", retried.Attempt)
	}

	// Crucial step: worker claims the retried job!
	// Before our fix, this failed with duplicate key violation on idx_job_attempts_per_job.
	claimed2, err := repo.ClaimNextJob(ctx, retryTestWorker, []string{retryTestQueue}, []string{retryTestHandler})
	if err != nil {
		t.Fatalf("ClaimNextJob on retried job failed: %v", err)
	}
	if claimed2 == nil {
		t.Fatalf("ClaimNextJob returned nil for retried job %s", jobID)
	}
	if claimed2.ID != jobID {
		t.Fatalf("claimed ID = %s; want %s", claimed2.ID, jobID)
	}
	if claimed2.Status != queuecore.StatusRunning {
		t.Fatalf("claimed status = %s; want running", claimed2.Status)
	}
	if claimed2.Attempt != 1 {
		t.Fatalf("claimed attempt = %d; want 1", claimed2.Attempt)
	}

	// Succeeded on second run
	succeeded, err := repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: retryTestWorker,
		JobID:    jobID,
		Result:   json.RawMessage(`{"recovered": true}`),
	})
	if err != nil {
		t.Fatalf("MarkJobSucceeded on retried job: %v", err)
	}
	if succeeded.Status != queuecore.StatusSucceeded {
		t.Fatalf("final status = %s; want succeeded", succeeded.Status)
	}
}
