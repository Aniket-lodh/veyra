package queuecore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// RetryParams is the input to Retry.
type RetryParams struct {
	JobID string
}

// Retry transitions a job back to status='queued' per SPEC §8.1.
func (r *Repository) Retry(ctx context.Context, p RetryParams) (*Job, error) {
	if p.JobID == "" {
		return nil, errors.New("queuecore.Repository.Retry: jobID is required")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Retry: begin tx: %w", err)
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
			slog.InfoContext(ctx, "queue.retry.manual.rejected",
				"jobId", p.JobID,
				"priorStatus", "",
				"reason", "not_found",
			)
			return nil, ErrJobNotFound
		}
		return nil, fmt.Errorf("queuecore.Repository.Retry: lock: %w", err)
	}

	priorStatus := job.Status

	switch priorStatus {
	case StatusFailed, StatusDeadLettered, StatusCancelled:
		// Retryable terminal/attention states.
	case StatusQueued, StatusRunning, StatusSucceeded:
		slog.InfoContext(ctx, "queue.retry.manual.rejected",
			"jobId", p.JobID,
			"priorStatus", string(priorStatus),
			"reason", "not_retryable",
		)
		return nil, ErrNotRetryable
	default:
		return nil, fmt.Errorf("queuecore.Repository.Retry: unexpected status %q", priorStatus)
	}

	const deleteAttemptsSQL = `
		DELETE FROM job_attempts
		WHERE job_id = $1
	`
	if _, err := tx.Exec(ctx, deleteAttemptsSQL, p.JobID); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Retry: delete attempts: %w", err)
	}

	const updateSQL = `
		UPDATE jobs
		SET status            = 'queued',
		    attempt           = 0,
		    error             = NULL,
		    started_at        = NULL,
		    result            = NULL,
		    scheduled_for     = now(),
		    current_worker_id = NULL,
		    lease_expires_at  = NULL,
		    next_retry_at     = NULL,
		    completed_at      = NULL,
		    cancelled_at      = NULL,
		    dead_lettered_at  = NULL,
		    callback_status   = CASE WHEN callback_url IS NOT NULL THEN 'pending' ELSE NULL END,
		    callback_attempts = 0,
		    callback_last_error = NULL,
		    callback_delivered_at = NULL,
		    callback_next_retry_at = NULL
		WHERE id = $1
		  AND status = $2
		RETURNING ` + jobColumns
	updated, err := scanJob(tx.QueryRow(ctx, updateSQL, p.JobID, string(priorStatus)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Status raced between lock and update.
			return nil, ErrNotRetryable
		}
		return nil, fmt.Errorf("queuecore.Repository.Retry: update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Retry: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.retry.manual.success",
		"jobId", p.JobID,
		"priorStatus", string(priorStatus),
	)

	return updated, nil
}

// ReplayDLQParams is the input to ReplayDLQ.
type ReplayDLQParams struct {
	Queue   string
	Handler string
	Limit   int
}

// ReplayDLQ transitions matching dead_lettered jobs back to 'queued' per SPEC §8.2.
func (r *Repository) ReplayDLQ(ctx context.Context, p ReplayDLQParams) ([]string, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	var queueParam *string
	if p.Queue != "" {
		queueParam = &p.Queue
	}
	var handlerParam *string
	if p.Handler != "" {
		handlerParam = &p.Handler
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const replaySQL = `
		WITH candidates AS (
			SELECT id
			FROM jobs
			WHERE status = 'dead_lettered'
			  AND ($1::text IS NULL OR queue = $1)
			  AND ($2::text IS NULL OR handler = $2)
			ORDER BY enqueued_at ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		UPDATE jobs j
		SET status            = 'queued',
		    attempt           = 0,
		    error             = NULL,
		    started_at        = NULL,
		    result            = NULL,
		    scheduled_for     = now(),
		    current_worker_id = NULL,
		    lease_expires_at  = NULL,
		    next_retry_at     = NULL,
		    completed_at      = NULL,
		    cancelled_at      = NULL,
		    dead_lettered_at  = NULL,
		    callback_status   = CASE WHEN j.callback_url IS NOT NULL THEN 'pending' ELSE NULL END,
		    callback_attempts = 0,
		    callback_last_error = NULL,
		    callback_delivered_at = NULL,
		    callback_next_retry_at = NULL
		FROM candidates c
		WHERE j.id = c.id
		RETURNING j.id
	`

	rows, err := tx.Query(ctx, replaySQL, queueParam, handlerParam, limit)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: query: %w", err)
	}
	defer rows.Close()

	jobIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: scan: %w", err)
		}
		jobIDs = append(jobIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: rows: %w", err)
	}
	rows.Close()

	if len(jobIDs) > 0 {
		const deleteAttemptsSQL = `
			DELETE FROM job_attempts
			WHERE job_id = ANY($1)
		`
		if _, err := tx.Exec(ctx, deleteAttemptsSQL, jobIDs); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: delete attempts: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ReplayDLQ: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.dlq.replay",
		"replayedCount", len(jobIDs),
		"queue", p.Queue,
		"handler", p.Handler,
		"limit", limit,
	)

	return jobIDs, nil
}
