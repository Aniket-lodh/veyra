package queuecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

type ForceReleaseLeaseParams struct {
	WorkerID string
	JobID    string
}

// ForceReleaseLeaseTx force-releases an active lease within an existing transaction.
// It verifies that the job is currently 'running' and leased to WorkerID, transitions
// the job safely back to 'queued' (clearing lease fields and recording an operator error note),
// and marks the active attempt as 'lease_lost'.
func (r *Repository) ForceReleaseLeaseTx(ctx context.Context, tx pgx.Tx, p ForceReleaseLeaseParams) error {
	if p.JobID == "" {
		return errors.New("queuecore.Repository.ForceReleaseLease: jobID is required")
	}
	if p.WorkerID == "" {
		return errors.New("queuecore.Repository.ForceReleaseLease: workerID is required")
	}

	const lockSQL = `
		SELECT status, current_worker_id
		FROM jobs
		WHERE id = $1
		FOR UPDATE
	`
	var (
		status          JobStatus
		currentWorkerID *string
	)
	err := tx.QueryRow(ctx, lockSQL, p.JobID).Scan(&status, &currentWorkerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrJobNotFound
		}
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: lock: %w", err)
	}

	if status != StatusRunning || currentWorkerID == nil || *currentWorkerID != p.WorkerID {
		return ErrLeaseConflict
	}

	const closeAttemptSQL = `
		UPDATE job_attempts
		SET outcome       = 'lease_lost',
		    ended_at      = now(),
		    error_class   = 'OperatorAction',
		    error_message = 'lease force-released by operator'
		WHERE job_id = $1
		  AND ended_at IS NULL
	`
	if _, err := tx.Exec(ctx, closeAttemptSQL, p.JobID); err != nil {
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: close attempt: %w", err)
	}

	errNote := JobError{
		Class:      "OperatorAction",
		Message:    "lease force-released by operator",
		OccurredAt: time.Now().UTC(),
	}
	errJSON, err := json.Marshal(errNote)
	if err != nil {
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: marshal error note: %w", err)
	}

	const updateJobSQL = `
		UPDATE jobs
		SET status            = 'queued',
		    current_worker_id = NULL,
		    lease_expires_at  = NULL,
		    next_retry_at     = NULL,
		    scheduled_for     = now(),
		    error             = $1
		WHERE id = $2
		  AND status = 'running'
		  AND current_worker_id = $3
	`
	cmd, err := tx.Exec(ctx, updateJobSQL, errJSON, p.JobID, p.WorkerID)
	if err != nil {
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: update job: %w", err)
	}
	if cmd.RowsAffected() == 0 {
		return ErrLeaseConflict
	}

	slog.InfoContext(ctx, "queue.lease.force_released",
		"jobId", p.JobID,
		"workerId", p.WorkerID,
	)
	return nil
}

// ForceReleaseLease atomically force-releases a lease under a newly created transaction.
func (r *Repository) ForceReleaseLease(ctx context.Context, p ForceReleaseLeaseParams) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := r.ForceReleaseLeaseTx(ctx, tx, p); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("queuecore.Repository.ForceReleaseLease: commit: %w", err)
	}
	return nil
}
