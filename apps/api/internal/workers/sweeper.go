package workers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Sweeper is the long-running goroutine handle.
type Sweeper struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewSweeper(pool *pgxpool.Pool, interval time.Duration) *Sweeper {
	return &Sweeper{pool: pool, interval: interval}
}

// Run drives one tick per `interval`.
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

	// One immediate tick so an api restart catches any worker that died while the api was down.
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
				// Don't propagate — keep ticking.
				slog.ErrorContext(ctx, "worker.sweeper.tick_failed",
					"event", "worker.sweeper.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

// tick runs one sweep: scan and transition any stale worker.
func (s *Sweeper) tick(ctx context.Context) error {
	// The threshold is per-row: `last_heartbeat_at < now() - (interval * 3)s`.
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
		// Don't log on context cancel — that's a normal shutdown signal, not a query failure.
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
			// Capture the first error but keep draining the result set so already-emitted log lines correspond to actual writes.
			if firstScanErr == nil {
				firstScanErr = fmt.Errorf("workers.Sweeper.tick: scan: %w", scanErr)
			}
			continue
		}
		// The structured event shape is intentional and stable.
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

// ctxErrString returns a stable string for context.Canceled vs Deadline in shutdown logs —.
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
