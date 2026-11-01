package queuecore

import (
	"math"
	"math/rand/v2"
)

// computeRetryDelaySeconds returns the wall-clock delay (in seconds) before
// the next attempt of a job that just failed should be permitted. The
// returned value is intended to be added to the database `now()` at the
// UPDATE site to produce `next_retry_at`. SPEC.md §3.5.1.
//
// This function is the **only** place jitter is sampled. The result of one
// call is committed to the row's `next_retry_at` and never recomputed —
// see SPEC.md §3.5.2 (the deterministic-after-commit invariant).
//
// `attempt` is the post-Dequeue-increment value, i.e. the attempt that
// just failed. The first failed attempt is attempt=1, which yields the
// base delay (no exponential multiplier yet).
func computeRetryDelaySeconds(b BackoffStrategy, attempt int) float64 {
	base := baseBackoffSeconds(b, attempt)
	jitter := 0.5 + rand.Float64() // uniform in [0.5, 1.5); SPEC §3.5.2
	return base * jitter
}

// baseBackoffSeconds is the pre-jitter delay implied by the backoff
// strategy at the given attempt number. Separated from
// computeRetryDelaySeconds so unit tests can verify the deterministic
// half of the rule without dealing with randomness.
//
// For unknown / malformed backoff strategies this returns a defensive
// 30-second default. Enqueue validates BackoffStrategy (see Validate),
// so reaching the fallback branch in production indicates a row mutated
// outside the public surface — log it and move on, do not panic.
func baseBackoffSeconds(b BackoffStrategy, attempt int) float64 {
	switch b.Kind {
	case "exponential":
		if b.BaseSeconds == nil || b.CapSeconds == nil {
			return 30
		}
		base := float64(*b.BaseSeconds)
		ceiling := float64(*b.CapSeconds)
		// attempt=1 → base × 2^0 = base
		// attempt=2 → base × 2^1 = 2×base
		// attempt=3 → base × 2^2 = 4×base
		// …clipped at cap.
		exponent := math.Pow(2, float64(attempt-1))
		delay := base * exponent
		if delay > ceiling {
			delay = ceiling
		}
		return delay
	case "fixed":
		if b.Seconds == nil {
			return 30
		}
		return float64(*b.Seconds)
	default:
		return 30
	}
}
