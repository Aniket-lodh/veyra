// Package workers — sweeper subsystem.
//
// A long-running goroutine that periodically scans the `workers` table and
// transitions any worker whose heartbeat has been silent longer than its
// declared interval × 3 into state='disconnected'.
//
// HARD CONSTRAINTS (treat these as load-bearing):
//
//  1. The sweeper writes `workers.state` ONLY. It does NOT
//     - touch `jobs.current_worker_id`,
//     - touch `jobs.lease_expires_at`,
//     - close `job_attempts` rows,
//     - reclaim leases, reschedule, or otherwise mutate queue state.
//     Reclaim semantics live INSIDE the dequeue path (queue-core §1.5).
//     The sweeper observes; dequeue reclaims. If a single concept is
//     written from two places, the two places drift. This is the
//     load-bearing rule for keeping the queue correct under crash.
//
//  2. The sweeper never DELETES. State transitions only.
//     active|idle|draining → disconnected. The historical row stays
//     forever (retention is a future, separate concern). Deletion
//     would lose reclaim traceability and create UI flicker on
//     restart-rename cycles.
//
//  3. Per-row threshold. Each worker declared its own
//     heartbeat_interval_seconds at startup; that value drives the
//     per-row "is this stale" test. No global threshold knob.
//
// Lifecycle:
//
//   - Started from cmd/api/main.go as a goroutine after the HTTP server.
//   - Stops when the supplied context is cancelled (signal-driven, same
//     ctx the rest of the api shuts down on).
//
// Singleton-by-deployment: today there is one api process, so one
// sweeper. With multiple api replicas the UPDATE is still safe (it is
// idempotent and uses row-level locks), but every replica's logs would
// claim credit for the same transitions. When that day arrives, wrap the
// tick in a Postgres advisory lock (pg_try_advisory_lock).
package workers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Sweeper is the long-running goroutine handle. Construct with NewSweeper;
// run with Run. The Run method blocks until ctx is cancelled.
type Sweeper struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewSweeper(pool *pgxpool.Pool, interval time.Duration) *Sweeper {
	return &Sweeper{pool: pool, interval: interval}
}

// Run drives one tick per `interval`. Errors during a tick are logged and
// the loop continues — a single failed sweep should not bring the api
// down, and the next tick will retry. Run returns nil on graceful ctx
// cancellation; it returns a non-nil error only if the ticker itself
// fails to start (never, in practice).
func (s *Sweeper) Run(ctx context.Context) error {
	if s.interval <= 0 {
		return fmt.Errorf("workers.Sweeper: interval must be > 0, got %v", s.interval)
	}

	slog.InfoContext(ctx, "worker.sweeper.started",
		"event", "worker.sweeper.started",
		"intervalSeconds", int(s.interval/time.Second),
	)

	t := time.NewTicker(s.interval)
	defer t.Stop()

	// One immediate tick so an api restart catches any worker that died
	// while the api was down. Without this, the api could take up to
	// `interval` seconds before its first sweep — survivable, but ugly.
	if err := s.tick(ctx); err != nil {
		slog.ErrorContext(ctx, "worker.sweeper.tick_failed",
			"event", "worker.sweeper.tick_failed",
			"err", err.Error(),
		)
	}

	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "worker.sweeper.stopped",
				"event", "worker.sweeper.stopped",
				"reason", ctxErrString(ctx.Err()),
			)
			return nil
		case <-t.C:
			if err := s.tick(ctx); err != nil {
				// Don't propagate — keep ticking. A transient DB blip
				// shouldn't kill the sweeper goroutine.
				slog.ErrorContext(ctx, "worker.sweeper.tick_failed",
					"event", "worker.sweeper.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

// tick runs one sweep: scan and transition any stale worker. Returns the
// first error encountered (so the caller can log it); does NOT short-circuit
// on a per-row scan failure, because partial progress is still useful.
func (s *Sweeper) tick(ctx context.Context) error {
	// The threshold is per-row: `last_heartbeat_at < now() - (interval * 3)s`.
	// Each worker declared its own heartbeat cadence at registration; we
	// honour that on a per-row basis rather than imposing a global one.
	// RETURNING gives us the rows we just transitioned so we can emit one
	// structured event per worker — the operator log is the source of
	// truth for "who was marked disconnected and when."
	const sql = `
		UPDATE workers
		SET state = 'disconnected'
		WHERE state IN ('active', 'idle', 'draining')
		  AND last_heartbeat_at < now() - make_interval(secs => heartbeat_interval_seconds * 3)
		RETURNING id, hostname, last_heartbeat_at,
		          heartbeat_interval_seconds,
		          EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::int AS stale_for_seconds
	`
	rows, err := s.pool.Query(ctx, sql)
	if err != nil {
		// Don't log on context cancel — that's a normal shutdown signal,
		// not a query failure. Treat ctx errors as the loop's job to handle.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return fmt.Errorf("workers.Sweeper.tick: query: %w", err)
	}
	defer rows.Close()

	var firstScanErr error
	for rows.Next() {
		var (
			id              string
			hostname        string
			lastHeartbeatAt time.Time
			intervalSecs    int
			staleForSecs    int
		)
		if scanErr := rows.Scan(&id, &hostname, &lastHeartbeatAt, &intervalSecs, &staleForSecs); scanErr != nil {
			// Capture the first error but keep draining the result set so
			// already-emitted log lines correspond to actual writes.
			if firstScanErr == nil {
				firstScanErr = fmt.Errorf("workers.Sweeper.tick: scan: %w", scanErr)
			}
			continue
		}
		// The structured event shape is intentional and stable. Any future
		// downstream consumer (event-stream table, ops dashboard timeline,
		// Loki alert) should be able to grep this name and rely on these
		// fields. Don't add or rename without considering downstreams.
		slog.WarnContext(ctx, "worker.sweeper.disconnected",
			"event", "worker.sweeper.disconnected",
			"workerId", id,
			"hostname", hostname,
			"lastHeartbeatAt", lastHeartbeatAt.Format(time.RFC3339Nano),
			"heartbeatIntervalSeconds", intervalSecs,
			"staleForSeconds", staleForSecs,
			"reason", "heartbeat_timeout",
		)
	}
	if err := rows.Err(); err != nil && firstScanErr == nil {
		return fmt.Errorf("workers.Sweeper.tick: rows: %w", err)
	}
	return firstScanErr
}

// ctxErrString returns a stable string for context.Canceled vs Deadline
// in shutdown logs — context.Canceled.Error() is just "context canceled"
// which is fine but we name it explicitly for ops dashboards that key
// off the field.
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
