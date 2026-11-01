//go:build integration

// Nack completion tests for SPEC §7 (failure classification) and the
// permanent branch of §3.4. Build-tagged; run with:
//
//	go test -tags integration ./...
package queuecore_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	nackTestWorker  = "01TESTNACKWORKER00000000001"
	nackTestQueue   = "nack-permanent-test"
	nackTestHandler = "test.handler"
)

// TestNack_Permanent_DeadLettersWithBudgetRemaining covers SPEC §7.3 row 1:
// a permanent disposition short-circuits a job that still has attempts left.
func TestNack_Permanent_DeadLettersWithBudgetRemaining(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTNACKPERM0000000000001"
	mustCreateJob(t, ctx, repo, jobID, 5)
	claimed := mustClaim(t, ctx, repo, jobID)

	res, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID:  nackTestWorker,
		JobID:     claimed.ID,
		Permanent: true,
		Error: queuecore.JobError{
			Class:   "http_4xx",
			Message: "HTTP 400 Bad Request",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if res.Status != queuecore.StatusDeadLettered {
		t.Fatalf("status = %s; want dead_lettered", res.Status)
	}
	if res.Attempt != 1 {
		t.Fatalf("attempt = %d; want 1 (Nack must not increment)", res.Attempt)
	}
	if res.Attempt >= res.MaxAttempts {
		t.Fatalf("attempt=%d max=%d — permanent DLQ must leave attempt < max_attempts so §7.3 heuristic holds",
			res.Attempt, res.MaxAttempts)
	}
	if res.NextRetryAt != nil {
		t.Fatalf("next_retry_at = %v; want nil on permanent path", res.NextRetryAt)
	}
	if res.DeadLetteredAt == nil {
		t.Fatal("dead_lettered_at is nil")
	}
	requireJobStatus(t, ctx, pool, jobID, "dead_lettered")
}

// TestNack_Permanent_PreservesHandlerErrorClass covers SPEC §7.3: permanent
// DLQ stores the handler's class, never AttemptBudgetExhausted (reclaim-only).
func TestNack_Permanent_PreservesHandlerErrorClass(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTNACKPERM0000000000002"
	mustCreateJob(t, ctx, repo, jobID, 3)
	mustClaim(t, ctx, repo, jobID)

	const wantClass = "invalid_payload"
	res, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID:  nackTestWorker,
		JobID:     jobID,
		Permanent: true,
		Error: queuecore.JobError{
			Class:   wantClass,
			Message: "malformed body",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if res.Status != queuecore.StatusDeadLettered {
		t.Fatalf("status = %s; want dead_lettered", res.Status)
	}
	if res.Error == nil {
		t.Fatal("jobs.error is nil")
	}
	if res.Error.Class != wantClass {
		t.Fatalf("error.class = %q; want %q (not AttemptBudgetExhausted)", res.Error.Class, wantClass)
	}
	if res.Error.Class == "AttemptBudgetExhausted" {
		t.Fatal("permanent Nack must never write AttemptBudgetExhausted")
	}

	var attemptClass *string
	if err := pool.QueryRow(ctx, `
		SELECT error_class FROM job_attempts
		WHERE job_id = $1 AND attempt_number = 1
	`, jobID).Scan(&attemptClass); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	if attemptClass == nil || *attemptClass != wantClass {
		t.Fatalf("attempt error_class = %v; want %q", attemptClass, wantClass)
	}
}

// TestNack_Permanent_NoNextRetryAt_SchedulerNeverPromotes covers SPEC §7.5:
// permanent jobs never land in failed+next_retry_at, so the scheduler
// predicate cannot promote them.
func TestNack_Permanent_NoNextRetryAt_SchedulerNeverPromotes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTNACKPERM0000000000003"
	mustCreateJob(t, ctx, repo, jobID, 4)
	mustClaim(t, ctx, repo, jobID)

	res, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID:  nackTestWorker,
		JobID:     jobID,
		Permanent: true,
		Error: queuecore.JobError{
			Class:   "http_4xx",
			Message: "404",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if res.NextRetryAt != nil {
		t.Fatalf("next_retry_at set on permanent path: %v", res.NextRetryAt)
	}

	// Simulate one scheduler tick predicate: failed rows due for promotion.
	var promotable int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM jobs
		WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now()
	`).Scan(&promotable); err != nil {
		t.Fatalf("scheduler predicate: %v", err)
	}
	if promotable != 0 {
		t.Fatalf("scheduler would promote %d rows; permanent job must be invisible", promotable)
	}
	requireJobStatus(t, ctx, pool, jobID, "dead_lettered")
}

// TestNack_Retry_DefaultUnchanged covers SPEC §7.2 rule 1: Permanent=false
// (zero value) keeps today's retryable Nack behavior.
func TestNack_Retry_DefaultUnchanged(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTNACKRETRY000000000001"
	mustCreateJob(t, ctx, repo, jobID, 3)
	mustClaim(t, ctx, repo, jobID)

	res, err := repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID: nackTestWorker,
		JobID:    jobID,
		// Permanent left false — default
		Error: queuecore.JobError{
			Class:   "http_5xx",
			Message: "502",
		},
	})
	if err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	if res.Status != queuecore.StatusFailed {
		t.Fatalf("status = %s; want failed (retryable)", res.Status)
	}
	if res.NextRetryAt == nil {
		t.Fatal("next_retry_at is nil; retryable Nack must schedule")
	}
	requireJobStatus(t, ctx, pool, jobID, "failed")
}

// TestReclaim_BudgetExhausted_NeverPermanent covers SPEC §7.6: reclaim DLQ
// uses AttemptBudgetExhausted and has no permanent disposition path.
func TestReclaim_BudgetExhausted_NeverPermanent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	jobID := "01TESTRECLAIMDLQ00000000001"
	mustCreateJob(t, ctx, repo, jobID, 1) // claim bumps attempt to 1 == max
	claimed := mustClaim(t, ctx, repo, jobID)
	if claimed.Attempt != 1 || claimed.MaxAttempts != 1 {
		t.Fatalf("setup: attempt=%d max=%d; want 1/1 so reclaim hits §5.6", claimed.Attempt, claimed.MaxAttempts)
	}

	if _, err := pool.Exec(ctx, `
		UPDATE jobs
		SET lease_expires_at = now() - make_interval(secs => $1)
		WHERE id = $2
	`, queuecore.ReclaimGraceSeconds+60, jobID); err != nil {
		t.Fatalf("fast-forward lease: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// SPEC §5: caller locks the row FOR UPDATE before invoking the primitive.
	var lockedID string
	if err := tx.QueryRow(ctx, `
		SELECT id FROM jobs WHERE id = $1 FOR UPDATE
	`, jobID).Scan(&lockedID); err != nil {
		t.Fatalf("lock job: %v", err)
	}

	result, err := queuecore.Reclaim(ctx, tx, queuecore.ReclaimParams{
		Mode:          queuecore.ReclaimModeTickRequeue,
		JobID:         jobID,
		Attempt:       claimed.Attempt,
		MaxAttempts:   claimed.MaxAttempts,
		PriorWorkerID: nackTestWorker,
	})
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if result.Outcome != queuecore.ReclaimOutcomeDeadLettered {
		t.Fatalf("outcome = %s; want dead_lettered", result.Outcome)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	job, err := repo.GetByID(ctx, jobID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if job.Status != queuecore.StatusDeadLettered {
		t.Fatalf("status = %s; want dead_lettered", job.Status)
	}
	if job.Error == nil || job.Error.Class != "AttemptBudgetExhausted" {
		t.Fatalf("error.class = %v; want AttemptBudgetExhausted (reclaim, never permanent)", job.Error)
	}
	if job.NextRetryAt != nil {
		t.Fatalf("next_retry_at = %v; reclaim DLQ must leave it unset", job.NextRetryAt)
	}
}

func mustCreateJob(t *testing.T, ctx context.Context, repo *queuecore.Repository, id string, maxAttempts int) {
	t.Helper()
	secs := 2
	_, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          id,
		Handler:     nackTestHandler,
		Queue:       nackTestQueue,
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

func mustClaim(t *testing.T, ctx context.Context, repo *queuecore.Repository, wantID string) *queuecore.Job {
	t.Helper()
	j, err := repo.ClaimNextJob(ctx, nackTestWorker, []string{nackTestQueue})
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

func requireJobStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, jobID, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM jobs WHERE id = $1`, jobID).Scan(&got); err != nil {
		t.Fatalf("requireJobStatus(%s): %v", jobID, err)
	}
	if got != want {
		t.Fatalf("job %s status = %s; want %s", jobID, got, want)
	}
}
