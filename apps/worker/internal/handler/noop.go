package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Noop stands in for real handler work: it sleeps for a fixed duration, then
// either succeeds or returns a SimulatedFailure at a configured rate. It exists
// so the queue, reclaim, retry, and chaos machinery can be exercised without a
// real workload — and so the soak/chaos harness behaves identically after the
// handler seam landed as it did when the simulation lived in the runtime.
//
// Real handlers (http_request, …) replace it on a per-job basis via the job's
// handler name; Noop is just one more registered handler.
type Noop struct {
	dur            time.Duration
	failurePercent int // rand.IntN(100) < n → SimulatedFailure; clamped to [0,100]
}

// NewNoop builds a Noop with the given simulated work duration and failure
// rate. failurePercent is clamped to [0,100]; 0 disables injected failures.
func NewNoop(dur time.Duration, failurePercent int) *Noop {
	switch {
	case failurePercent < 0:
		failurePercent = 0
	case failurePercent > 100:
		failurePercent = 100
	}
	return &Noop{dur: dur, failurePercent: failurePercent}
}

// Handle sleeps, then succeeds or injects a failure. On ctx cancellation it
// returns ctx.Err() promptly so the runtime takes the reclaim path (no
// ack/nack) — matching the pre-seam simulation's behavior exactly.
func (n *Noop) Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error) {
	start := time.Now()

	if !sleepCtx(ctx, n.dur) {
		return nil, ctx.Err()
	}

	if n.failurePercent > 0 && rand.IntN(100) < n.failurePercent {
		return nil, &Error{
			Class:   "SimulatedFailure",
			Message: fmt.Sprintf("random failure injected (%d%%) after %dms", n.failurePercent, time.Since(start).Milliseconds()),
		}
	}

	result, _ := json.Marshal(map[string]any{
		"simulated":  true,
		"durationMs": time.Since(start).Milliseconds(),
	})
	return result, nil
}

// sleepCtx returns true if d elapsed, false if ctx was cancelled first. A
// non-positive duration returns immediately, reporting whether ctx is alive.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
