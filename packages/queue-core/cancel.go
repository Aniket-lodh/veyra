// Cancel primitive — SPEC.md §6.
//
// Operator-initiated terminal stop. One implementation; the API handler is
// the only call site in v1. Cooperative for running jobs: clears lease
// ownership so the worker's renewer fails and abandons without Ack/Nack.
package queuecore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// CancelParams is the input to Cancel. jobId is required; cancel reason is
// deferred (SPEC §6.1).
type CancelParams struct {
	JobID string
}

// Cancel transitions a job to status='cancelled' per SPEC §6.2.
//
//   - queued / failed / running → cancelled (running also closes the open
//     attempt with outcome='cancelled')
//   - already cancelled → idempotent success
//   - succeeded / dead_lettered → ErrNotCancellable
//   - missing → ErrJobNotFound
func (r *Repository) Cancel(ctx context.Context, p CancelParams) (*Job, error) {
	if p.JobID == "" {
		return nil, errors.New("queuecore.Repository.Cancel: jobID is required")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Cancel: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const lockSQL = `
		SELECT ` + jobColumns + `
		FROM jobs
		WHERE id = $1
		FOR UPDATE
	`
	job, err := scanJob(tx.QueryRow(ctx, lockSQL, p.JobID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.InfoContext(ctx, "queue.cancel.rejected",
				"jobId", p.JobID,
				"priorStatus", "",
				"reason", "not_found",
			)
			return nil, ErrJobNotFound
		}
		return nil, fmt.Errorf("queuecore.Repository.Cancel: lock: %w", err)
	}

	priorStatus := job.Status

	switch priorStatus {
	case StatusCancelled:
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.Cancel: commit: %w", err)
		}
		slog.InfoContext(ctx, "queue.cancel.success",
			"jobId", p.JobID,
			"priorStatus", string(priorStatus),
			"idempotent", true,
		)
		return job, nil

	case StatusSucceeded, StatusDeadLettered:
		slog.InfoContext(ctx, "queue.cancel.rejected",
			"jobId", p.JobID,
			"priorStatus", string(priorStatus),
			"reason", "not_cancellable",
		)
		return nil, ErrNotCancellable

	case StatusRunning:
		const closeAttemptSQL = `
			UPDATE job_attempts
			SET outcome  = 'cancelled',
			    ended_at = now()
			WHERE job_id = $1
			  AND ended_at IS NULL
		`
		if _, err := tx.Exec(ctx, closeAttemptSQL, p.JobID); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.Cancel: close attempt: %w", err)
		}

	case StatusQueued, StatusFailed:
		// Job-row update below is sufficient.
	default:
		return nil, fmt.Errorf("queuecore.Repository.Cancel: unexpected status %q", priorStatus)
	}

	const updateSQL = `
		UPDATE jobs
		SET status            = 'cancelled',
		    cancelled_at      = now(),
		    next_retry_at     = NULL,
		    current_worker_id = NULL,
		    lease_expires_at  = NULL
		WHERE id = $1
		  AND status = $2
		RETURNING ` + jobColumns
	updated, err := scanJob(tx.QueryRow(ctx, updateSQL, p.JobID, string(priorStatus)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Row changed under us between lock and update — should not
			// happen under FOR UPDATE, but treat as not-cancellable race.
			return nil, ErrNotCancellable
		}
		return nil, fmt.Errorf("queuecore.Repository.Cancel: update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Cancel: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.cancel.success",
		"jobId", p.JobID,
		"priorStatus", string(priorStatus),
		"idempotent", false,
	)
	return updated, nil
}
