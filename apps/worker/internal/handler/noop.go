package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Noop stands in for real handler work: it sleeps for a fixed duration, then either succeeds or returns a SimulatedFailure at a configured rate.
type Noop struct {
	dur            time.Duration
	failurePercent int // rand.IntN(100) < n → SimulatedFailure; clamped to [0,100]
}

// NewNoop builds a Noop with the given simulated work duration and failure rate.
func NewNoop(dur time.Duration, failurePercent int) *Noop {
	switch {
	case failurePercent < 0:
		failurePercent = 0
	case failurePercent > 100:
		failurePercent = 100
	}
	return &Noop{dur: dur, failurePercent: failurePercent}
}

// Handle sleeps, then succeeds or injects a failure.
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

// sleepCtx returns true if d elapsed, false if ctx was cancelled first.
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
