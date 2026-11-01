// Package retries — the retry scheduler.
//
// A long-running goroutine that periodically scans the `jobs` table for
// rows in (status='failed', next_retry_at <= now()) and promotes them
// back to `queued` in one atomic UPDATE. This is the second phase of the
// retry pipeline; the first phase is Nack-side computation of
// `next_retry_at` in packages/queue-core/repository.go.
//
// HARD CONSTRAINTS (see SPEC.md §3.5):
//
//  1. The scheduler ONLY flips `(status, next_retry_at)`. It does NOT
//     touch `attempt`, `priority`, `payload`, or anything else. Identity
//     is preserved across retries.
//
//  2. The scheduler does NOT recompute `next_retry_at`. The jitter was
//     sampled once by Nack and committed to the row; the scheduler is
//     a pure mover, not a re-decider. (Violating this destroys the
//     deterministic-after-commit invariant, SPEC §3.5.2.)
//
//  3. The scheduler does NOT consult `jobs.backoff` or any retry policy.
//     All of that lives in Nack. If you find yourself reading backoff
//     here, you are violating constraint 2.
//
//  4. The scheduler is stateless. Crash = delay, never loss / duplication.
//     The next tick reproduces the same predicate against the same data.
//
// HA note: the UPDATE uses FOR UPDATE SKIP LOCKED, so two schedulers
// running concurrently is safe — neither will promote the same row twice.
// Today the api process is singleton, so we don't yet need an advisory
// lock; ADR-0006 documents the future split if needed.
package retries

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Scheduler is the long-running goroutine handle. Construct with
// NewScheduler; drive with Run. The Run method blocks until ctx is
// cancelled.
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

// Run drives one tick per `interval`. Errors during a tick are logged and
// the loop continues — a single failed sweep should not bring the api
// down, and the next tick will retry against the same predicate.
//
// Returns nil on graceful ctx cancellation; a non-nil error only if the
// configuration is invalid at start time.
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

	// Immediate tick on boot so an api restart promotes any backlog that
	// accumulated during the downtime. Without this the worst-case
	// post-restart promotion lag equals `interval`.
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
//
// The CTE form is load-bearing: it lets us measure scheduler lag
// (`now() - next_retry_at`) BEFORE the UPDATE clears `next_retry_at`,
// so the per-row `lagMs` we emit in the queue.retry.promoted event is
// meaningful. A naive `UPDATE … RETURNING EXTRACT(… - next_retry_at)`
// would evaluate the EXTRACT against the post-UPDATE tuple, which has
// `next_retry_at = NULL` — the lag would always be NULL/garbage.
//
// The atomic shape is preserved: the CTE locks rows with
// FOR UPDATE SKIP LOCKED inside the same statement; the UPDATE…FROM
// joins them; commit happens at statement boundary. SPEC §3.5.3.
//
// The partial index `idx_jobs_retry_pending` (migration 000001) serves
// the predicate.
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
		// One event per row promoted. SPEC §3.5.10. The fields are
		// intentional and stable — downstreams correlate by jobId across
		// queue.retry.scheduled (Nack) → queue.retry.promoted (here) →
		// queue.dequeue.claimed (worker).
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
