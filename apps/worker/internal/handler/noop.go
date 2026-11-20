package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type Noop struct {
	dur            time.Duration
	failurePercent int
}

func NewNoop(dur time.Duration, failurePercent int) *Noop {
	switch {
	case failurePercent < 0:
		failurePercent = 0
	case failurePercent > 100:
		failurePercent = 100
	}
	return &Noop{dur: dur, failurePercent: failurePercent}
}

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
