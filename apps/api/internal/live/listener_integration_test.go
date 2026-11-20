//go:build integration

package live_test

import (
	"context"
	"testing"
	"time"

	"github.com/Aniket-lodh/veyra/api/internal/live"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"
)

func TestListener_NotifyReachesHub(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	hub := live.NewHub()
	sub := hub.Subscribe()
	defer sub.Unsubscribe()

	listener := live.NewListener(pool.Config().ConnString(), hub)
	errCh := make(chan error, 1)
	go func() {
		errCh <- listener.Run(ctx)
	}()

	// Wait until LISTEN is ready (best-effort short sleep + retry notify).
	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if _, err := pool.Exec(ctx, `SELECT pg_notify('veyra_ui', 'jobs')`); err != nil {
			lastErr = err
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case ev := <-sub.C():
			foundJobs, foundStats := false, false
			for _, r := range ev.Resources {
				if r == live.ResourceJobs {
					foundJobs = true
				}
				if r == live.ResourceStats {
					foundStats = true
				}
			}
			if !foundJobs || !foundStats {
				t.Fatalf("resources=%v want jobs+stats", ev.Resources)
			}
			cancel()
			return
		case <-time.After(200 * time.Millisecond):
			// retry notify — listener may still be connecting
		}
	}
	cancel()
	t.Fatalf("no hub event after notifies; lastErr=%v listenerErr=%v", lastErr, <-errCh)
}
