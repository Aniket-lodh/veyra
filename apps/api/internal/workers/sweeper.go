package workers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Sweeper struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewSweeper(pool *pgxpool.Pool, interval time.Duration) *Sweeper {
	return &Sweeper{pool: pool, interval: interval}
}

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
				slog.ErrorContext(ctx, "worker.sweeper.tick_failed",
					"event", "worker.sweeper.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

func (s *Sweeper) tick(ctx context.Context) error {
	const sql = `
		UPDATE workers
		SET state = 'disconnected'
		WHERE state IN ('active', 'idle', 'draining', 'cordoned')
		  AND last_heartbeat_at < now() - make_interval(secs => heartbeat_interval_seconds * 3)
		RETURNING id, hostname, last_heartbeat_at,
		          heartbeat_interval_seconds,
		          EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::int AS stale_for_seconds
	`
	rows, err := s.pool.Query(ctx, sql)
	if err != nil {
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
			if firstScanErr == nil {
				firstScanErr = fmt.Errorf("workers.Sweeper.tick: scan: %w", scanErr)
			}
			continue
		}
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
