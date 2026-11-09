package live

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	channelName = "veyra_ui"

	listenBackoffMin = 500 * time.Millisecond
	listenBackoffMax = 15 * time.Second
)

// Listener holds a dedicated Postgres connection on LISTEN veyra_ui.
type Listener struct {
	databaseURL string
	hub         *Hub
}

func NewListener(databaseURL string, hub *Hub) *Listener {
	return &Listener{databaseURL: databaseURL, hub: hub}
}

// Run blocks until ctx is cancelled. Transient errors reconnect with backoff.
func (l *Listener) Run(ctx context.Context) error {
	backoff := listenBackoffMin
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := l.listenOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		jitter := time.Duration(rand.Int63n(int64(backoff / 2))) //nolint:gosec // reconnect jitter only
		wait := backoff + jitter
		if wait > listenBackoffMax {
			wait = listenBackoffMax
		}
		slog.ErrorContext(ctx, "live.listen.restarting",
			"event", "live.listen.restarting",
			"err", err.Error(),
			"retryIn", wait.String(),
		)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > listenBackoffMax {
			backoff = listenBackoffMax
		}
	}
}

func (l *Listener) listenOnce(ctx context.Context) error {
	conn, err := pgx.Connect(ctx, l.databaseURL)
	if err != nil {
		return fmt.Errorf("live.Listener: connect: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()

	if _, err := conn.Exec(ctx, "LISTEN "+channelName); err != nil {
		return fmt.Errorf("live.Listener: LISTEN: %w", err)
	}
	slog.InfoContext(ctx, "live.listen.ready",
		"event", "live.listen.ready",
		"channel", channelName,
	)

	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			return fmt.Errorf("live.Listener: wait: %w", err)
		}
		if notification == nil {
			continue
		}
		l.hub.PublishNotify(notification.Payload)
	}
}
