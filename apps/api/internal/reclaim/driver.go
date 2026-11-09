// Package reclaim runs the api-side periodic reclaim driver.
package reclaim

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Driver is the long-running goroutine handle.
type Driver struct {
	pool       *pgxpool.Pool
	interval   time.Duration
	batchLimit int
}

// NewDriver constructs the periodic reclaim driver.
func NewDriver(pool *pgxpool.Pool, interval time.Duration, batchLimit int) *Driver {
	return &Driver{
		pool:       pool,
		interval:   interval,
		batchLimit: batchLimit,
	}
}

// Run drives one tick per `interval`.
func (d *Driver) Run(ctx context.Context) error {
	if d.interval <= 0 {
		return fmt.Errorf("reclaim.Driver: interval must be > 0, got %v", d.interval)
	}
	if d.batchLimit < 1 {
		return fmt.Errorf("reclaim.Driver: batchLimit must be >= 1, got %d", d.batchLimit)
	}

	slog.InfoContext(ctx, "queue.reclaim.tick.started",
		"intervalSeconds", int(d.interval/time.Second),
		"rowLimit", d.batchLimit,
		"reclaimGraceSeconds", queuecore.ReclaimGraceSeconds,
	)

	t := time.NewTicker(d.interval)
	defer t.Stop()

	// Immediate tick on boot so an api restart catches any reclaimable row that accumulated during the downtime.
	if err := d.tick(ctx); err != nil {
		slog.ErrorContext(ctx, "queue.reclaim.tick_failed",
			"err", err.Error(),
		)
	}

	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "queue.reclaim.tick.stopped",
				"reason", ctxErrString(ctx.Err()),
			)
			return nil
		case <-t.C:
			if err := d.tick(ctx); err != nil {
				slog.ErrorContext(ctx, "queue.reclaim.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

// tick runs one reclaim sweep.
func (d *Driver) tick(ctx context.Context) error {
	tickStart := time.Now()

	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("reclaim.Driver.tick: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pre-tick lag canary: how stale is the oldest expired-lease row at the moment of the SELECT?
	const lagSQL = `
		SELECT COALESCE(
		  EXTRACT(EPOCH FROM (now() - min(lease_expires_at)))::int,
		  0
		)
		FROM jobs
		WHERE status = 'running'
		  AND lease_expires_at + make_interval(secs => $1) <= now()
	`
	var lagSeconds int
	if err := tx.QueryRow(ctx, lagSQL, queuecore.ReclaimGraceSeconds).Scan(&lagSeconds); err != nil {
		// Lag observation is best-effort; tick continues.
		slog.WarnContext(ctx, "queue.reclaim.lag_canary_failed",
			"err", err.Error(),
		)
		lagSeconds = -1
	}

	const selectBatchSQL = `
		SELECT id, attempt, max_attempts, current_worker_id
		FROM jobs
		WHERE status = 'running'
		  AND lease_expires_at + make_interval(secs => $1) <= now()
		ORDER BY lease_expires_at ASC
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	`
	rows, err := tx.Query(ctx, selectBatchSQL, queuecore.ReclaimGraceSeconds, d.batchLimit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return fmt.Errorf("reclaim.Driver.tick: select batch: %w", err)
	}

	type candidate struct {
		ID            string
		Attempt       int
		MaxAttempts   int
		PriorWorkerID string
	}
	var batch []candidate
	for rows.Next() {
		var c candidate
		var priorWorker *string
		if err := rows.Scan(&c.ID, &c.Attempt, &c.MaxAttempts, &priorWorker); err != nil {
			rows.Close()
			return fmt.Errorf("reclaim.Driver.tick: scan: %w", err)
		}
		if priorWorker != nil {
			c.PriorWorkerID = *priorWorker
		}
		batch = append(batch, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("reclaim.Driver.tick: rows err: %w", err)
	}
	rows.Close()

	// Per-row SAVEPOINT (SPEC §5.11).
	var reclaimedRequeued, reclaimedDLQ, stale, failed int
	for _, c := range batch {
		spName := "sp_reclaim_" + safeSavepointSuffix(c.ID)
		if _, err := tx.Exec(ctx, "SAVEPOINT "+spName); err != nil {
			return fmt.Errorf("reclaim.Driver.tick: savepoint %s: %w", spName, err)
		}

		result, reclaimErr := queuecore.Reclaim(ctx, tx, queuecore.ReclaimParams{
			Mode:          queuecore.ReclaimModeTickRequeue,
			JobID:         c.ID,
			Attempt:       c.Attempt,
			MaxAttempts:   c.MaxAttempts,
			PriorWorkerID: c.PriorWorkerID,
		})
		if reclaimErr != nil {
			failed++
			slog.ErrorContext(ctx, "queue.reclaim.row.failed",
				"site", "tick",
				"jobId", c.ID,
				"err", reclaimErr.Error(),
			)
			if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName); err != nil {
				// If we cannot roll back the savepoint the entire tx is suspect; abort the tick and let the next one try again.
				return fmt.Errorf("reclaim.Driver.tick: rollback savepoint %s: %w", spName, err)
			}
			continue
		}
		if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+spName); err != nil {
			return fmt.Errorf("reclaim.Driver.tick: release savepoint %s: %w", spName, err)
		}

		switch result.Outcome {
		case queuecore.ReclaimOutcomeRequeued:
			reclaimedRequeued++
		case queuecore.ReclaimOutcomeDeadLettered:
			reclaimedDLQ++
		case queuecore.ReclaimOutcomeStale:
			stale++
		default:
			// Tick path never returns Claimed; treat as failure if it somehow happens.
			failed++
			slog.ErrorContext(ctx, "queue.reclaim.row.unexpected_outcome",
				"site", "tick",
				"jobId", c.ID,
				"outcome", string(result.Outcome),
			)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("reclaim.Driver.tick: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.reclaim.tick",
		"scanned", len(batch),
		"reclaimedRequeued", reclaimedRequeued,
		"reclaimedDlq", reclaimedDLQ,
		"stale", stale,
		"failed", failed,
		"elapsedMs", time.Since(tickStart).Milliseconds(),
		"reclaimTickLagSeconds", lagSeconds,
	)
	return nil
}

// safeSavepointSuffix returns a name fragment safe to embed in "SAVEPOINT <name>" without quoting.
func safeSavepointSuffix(id string) string {
	out := make([]byte, 0, len(id))
	for i := 0; i < len(id); i++ {
		b := id[i]
		switch {
		case b >= 'A' && b <= 'Z':
			out = append(out, b)
		case b >= 'a' && b <= 'z':
			out = append(out, b)
		case b >= '0' && b <= '9':
			out = append(out, b)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
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
