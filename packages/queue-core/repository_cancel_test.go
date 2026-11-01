//go:build integration

// Cancel tests for SPEC §6. Build-tagged; run with:
//
//	go test -tags integration ./...
package queuecore_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	cancelTestWorker  = "01TESTCANCELWORKER0000000001"
	cancelTestQueue   = "cancel-test"
	cancelTestHandler = "test.handler"
)

// TestCancel_Queued covers SPEC §6.2: queued → cancelled.
func TestCancel_Queued(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTCANCELQUEUED00000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 3)

	job, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if job.Status != queuecore.StatusCancelled {
		t.Fatalf("status = %s; want cancelled", job.Status)
	}
	if job.CancelledAt == nil {
		t.Fatal("cancelled_at is nil")
	}
	if job.NextRetryAt != nil {
		t.Fatalf("next_retry_at = %v; want nil", job.NextRetryAt)
	}
	requireJobStatus(t, ctx, pool, jobID, "cancelled")
}

// TestCancel_FailedClearsNextRetryAt covers SPEC §6.2 failed + §3.5.6.
func TestCancel_FailedClearsNextRetryAt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTCANCELFAILED00000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 5)
	mustClaimCancel(t, ctx, repo, jobID)

	failed, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: cancelTestWorker,
		JobID:    jobID,
		Error: queuecore.JobError{
			Class:   "http_5xx",
			Message: "temporary",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if failed.Status != queuecore.StatusFailed {
		t.Fatalf("status after nack = %s; want failed", failed.Status)
	}
	if failed.NextRetryAt == nil {
		t.Fatal("next_retry_at nil after retryable nack")
	}

	job, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if job.Status != queuecore.StatusCancelled {
		t.Fatalf("status = %s; want cancelled", job.Status)
	}
	if job.NextRetryAt != nil {
		t.Fatalf("next_retry_at = %v; Cancel must clear it (§3.5.6)", job.NextRetryAt)
	}
	requireJobStatus(t, ctx, pool, jobID, "cancelled")
}

// TestCancel_RunningClosesAttemptCancelled covers SPEC §6.4.
func TestCancel_RunningClosesAttemptCancelled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTCANCELRUNNING0000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 3)
	mustClaimCancel(t, ctx, repo, jobID)

	job, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if job.Status != queuecore.StatusCancelled {
		t.Fatalf("status = %s; want cancelled", job.Status)
	}
	if job.CurrentWorkerID != nil {
		t.Fatalf("current_worker_id = %v; want nil", job.CurrentWorkerID)
	}
	if job.LeaseExpiresAt != nil {
		t.Fatalf("lease_expires_at = %v; want nil", job.LeaseExpiresAt)
	}

	outcome, ended := requireOpenAttemptClosed(t, ctx, pool, jobID)
	if outcome != "cancelled" {
		t.Fatalf("attempt outcome = %s; want cancelled (not lease_lost)", outcome)
	}
	if ended.IsZero() {
		t.Fatal("attempt ended_at is zero")
	}
}

// TestCancel_IdempotentWhenAlreadyCancelled covers SPEC §6.2 idempotent path.
func TestCancel_IdempotentWhenAlreadyCancelled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	repo := queuecore.NewRepository(testsupport.StartPostgres(t))

	jobID := "01TESTCANCELIDEM0000000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 3)

	first, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel first: %v", err)
	}
	second, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if err != nil {
		t.Fatalf("Cancel second: %v", err)
	}
	if second.Status != queuecore.StatusCancelled {
		t.Fatalf("status = %s; want cancelled", second.Status)
	}
	if first.CancelledAt == nil || second.CancelledAt == nil {
		t.Fatal("cancelled_at missing")
	}
	if !first.CancelledAt.Equal(*second.CancelledAt) {
		t.Fatalf("idempotent cancel mutated cancelled_at: %v → %v",
			first.CancelledAt, second.CancelledAt)
	}
}

// TestCancel_RejectsSucceeded covers SPEC §6.2 / §6.3.
func TestCancel_RejectsSucceeded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	repo := queuecore.NewRepository(testsupport.StartPostgres(t))

	jobID := "01TESTCANCELSUCC0000000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 3)
	mustClaimCancel(t, ctx, repo, jobID)
	if _, err := repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: cancelTestWorker,
		JobID:    jobID,
	}); err != nil {
		t.Fatalf("MarkJobSucceeded: %v", err)
	}

	_, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if !errors.Is(err, queuecore.ErrNotCancellable) {
		t.Fatalf("err = %v; want ErrNotCancellable", err)
	}
}

// TestCancel_RejectsDeadLettered covers SPEC §6.2 / §6.3.
func TestCancel_RejectsDeadLettered(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	repo := queuecore.NewRepository(testsupport.StartPostgres(t))

	jobID := "01TESTCANCELDLQ000000000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 1)
	mustClaimCancel(t, ctx, repo, jobID)
	if _, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: cancelTestWorker,
		JobID:    jobID,
		Error: queuecore.JobError{
			Class:   "http_4xx",
			Message: "gone",
		},
	}); err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}

	_, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID})
	if !errors.Is(err, queuecore.ErrNotCancellable) {
		t.Fatalf("err = %v; want ErrNotCancellable", err)
	}
}

// TestCancel_NotFound covers SPEC §6.3.
func TestCancel_NotFound(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	repo := queuecore.NewRepository(testsupport.StartPostgres(t))

	_, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: "01TESTCANCELMISSING0000000001"})
	if !errors.Is(err, queuecore.ErrJobNotFound) {
		t.Fatalf("err = %v; want ErrJobNotFound", err)
	}
}

// TestCancel_ThenAckFails covers SPEC §6.5 Cancel-first vs Ack.
func TestCancel_ThenAckFails(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	repo := queuecore.NewRepository(testsupport.StartPostgres(t))

	jobID := "01TESTCANCELACKRACE0000000001"
	mustCreateCancelJob(t, ctx, repo, jobID, 3)
	mustClaimCancel(t, ctx, repo, jobID)

	if _, err := repo.Cancel(ctx, queuecore.CancelParams{JobID: jobID}); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	_, err := repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: cancelTestWorker,
		JobID:    jobID,
	})
	if !errors.Is(err, queuecore.ErrLeaseLost) {
		t.Fatalf("Ack after Cancel: err = %v; want ErrLeaseLost", err)
	}

	job, err := repo.GetByID(ctx, jobID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if job.Status != queuecore.StatusCancelled {
		t.Fatalf("status = %s; want cancelled (Ack must not overwrite)", job.Status)
	}
}

func mustCreateCancelJob(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string, maxAttempts int) {
	t.Helper()
	secs := 2
	_, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          id,
		Handler:     cancelTestHandler,
		Queue:       cancelTestQueue,
		MaxAttempts: maxAttempts,
		Backoff: queuecore.BackoffStrategy{
			Kind:    "fixed",
			Seconds: &secs,
		},
		Payload: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("Create(%s): %v", id, err)
	}
}

func mustClaimCancel(t *testing.T, ctx context.Context, repo *queuecore.Repository, wantID string) *queuecore.Job {
	t.Helper()
	j, err := repo.ClaimNextJob(ctx, cancelTestWorker, []string{cancelTestQueue})
	if err != nil {
		t.Fatalf("ClaimNextJob: %v", err)
	}
	if j == nil {
		t.Fatal("ClaimNextJob returned nil")
	}
	if j.ID != wantID {
		t.Fatalf("claimed %s; want %s", j.ID, wantID)
	}
	return j
}

func requireOpenAttemptClosed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, jobID string) (outcome string, endedAt time.Time) {
	t.Helper()
	var ended *time.Time
	var out *string
	err := pool.QueryRow(ctx, `
		SELECT outcome::text, ended_at
		FROM job_attempts
		WHERE job_id = $1
		ORDER BY attempt_number DESC
		LIMIT 1
	`, jobID).Scan(&out, &ended)
	if err != nil {
		t.Fatalf("requireOpenAttemptClosed: %v", err)
	}
	if out == nil {
		t.Fatal("attempt outcome is NULL — should have been closed")
	}
	if ended == nil {
		t.Fatal("attempt ended_at is NULL — should have been closed")
	}
	return *out, *ended
}
