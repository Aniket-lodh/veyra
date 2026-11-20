// Package retries runs the retry scheduler.
package retries

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Scheduler is the long-running goroutine handle.
type Scheduler struct {
	pool       *pgxpool.Pool
	interval   time.Duration
	batchLimit int
}

func NewScheduler(pool *pgxpool.Pool, interval time.Duration, batchLimit int) *Scheduler {
	return &Scheduler{
		pool:       pool,
		interval:   interval,
		batchLimit: batchLimit,
	}
}

// Run drives one tick per `interval`.
func (s *Scheduler) Run(ctx context.Context) error {
	if s.interval <= 0 {
		return fmt.Errorf("retries.Scheduler: interval must be > 0, got %v", s.interval)
	}
	if s.batchLimit < 1 {
		return fmt.Errorf("retries.Scheduler: batchLimit must be >= 1, got %d", s.batchLimit)
	}

	slog.InfoContext(ctx, "queue.retry.scheduler.started",
		"event", "queue.retry.scheduler.started",
		"intervalSeconds", int(s.interval/time.Second),
		"batchLimit", s.batchLimit,
	)

	t := time.NewTicker(s.interval)
	defer t.Stop()

	// Immediate tick on boot so an api restart promotes any backlog that accumulated during the downtime.
	if err := s.tick(ctx); err != nil {
		slog.ErrorContext(ctx, "queue.retry.scheduler.tick_failed",
			"event", "queue.retry.scheduler.tick_failed",
			"err", err.Error(),
		)
	}

	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "queue.retry.scheduler.stopped",
				"event", "queue.retry.scheduler.stopped",
				"reason", ctxErrString(ctx.Err()),
			)
			return nil
		case <-t.C:
			if err := s.tick(ctx); err != nil {
				slog.ErrorContext(ctx, "queue.retry.scheduler.tick_failed",
					"event", "queue.retry.scheduler.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

// tick runs one promotion sweep.
func (s *Scheduler) tick(ctx context.Context) error {
	const promoteSQL = `
		WITH due AS (
		    SELECT id, EXTRACT(EPOCH FROM (now() - next_retry_at))::float * 1000 AS lag_ms
		    FROM   jobs
		    WHERE  status        = 'failed'
		      AND  next_retry_at IS NOT NULL
		      AND  next_retry_at <= now()
		    ORDER BY next_retry_at ASC
		    LIMIT  $1
		    FOR UPDATE SKIP LOCKED
		)
		UPDATE jobs j
		SET    status        = 'queued',
		       next_retry_at = NULL
		FROM   due
		WHERE  j.id = due.id
		RETURNING j.id, j.queue, j.handler, j.attempt, due.lag_ms
	`
	rows, err := s.pool.Query(ctx, promoteSQL, s.batchLimit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return fmt.Errorf("retries.Scheduler.tick: query: %w", err)
	}
	defer rows.Close()

	var firstScanErr error
	for rows.Next() {
		var (
			id      string
			queue   string
			handler string
			attempt int
			lagMs   float64
		)
		if scanErr := rows.Scan(&id, &queue, &handler, &attempt, &lagMs); scanErr != nil {
			if firstScanErr == nil {
				firstScanErr = fmt.Errorf("retries.Scheduler.tick: scan: %w", scanErr)
			}
			continue
		}
		// One event per row promoted.
		slog.InfoContext(ctx, "queue.retry.promoted",
			"event", "queue.retry.promoted",
			"jobId", id,
			"queue", queue,
			"handler", handler,
			"attempt", attempt,
			"lagMs", int64(lagMs),
		)
	}
	if err := rows.Err(); err != nil && firstScanErr == nil {
		return fmt.Errorf("retries.Scheduler.tick: rows: %w", err)
	}
	return firstScanErr
}

func ctxErrString(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case err != nil:
		return err.Error()
	default:
		return "nil"
	}
}
