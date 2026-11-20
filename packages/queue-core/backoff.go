package queuecore

import (
	"math"
	"math/rand/v2"
)

// computeRetryDelaySeconds returns the wall-clock delay (in seconds) before the next attempt of a job that just failed should be permitted.
func computeRetryDelaySeconds(b BackoffStrategy, attempt int) float64 {
	base := baseBackoffSeconds(b, attempt)
	jitter := 0.5 + rand.Float64() // uniform in [0.5, 1.5); SPEC §3.5.2
	return base * jitter
}

// baseBackoffSeconds is the pre-jitter delay implied by the backoff strategy at the given attempt number.
func baseBackoffSeconds(b BackoffStrategy, attempt int) float64 {
	switch b.Kind {
	case "exponential":
		if b.BaseSeconds == nil || b.CapSeconds == nil {
			return 30
		}
		base := float64(*b.BaseSeconds)
		ceiling := float64(*b.CapSeconds)
		// attempt=1 → base × 2^0 = base attempt=2 → base × 2^1 = 2×base attempt=3 → base × 2^2 = 4×base …clipped at cap.
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
