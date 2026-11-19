package queuecore

import (
	"math"
	"testing"
)

// These tests cover the pure-math half of the retry pipeline (SPEC §3.5.1 and the deterministic half of §3.5.2).

func intp(i int) *int { return &i }

// TestBaseBackoffSeconds_Exponential — SPEC §3.5.1, exponential case.
func TestBaseBackoffSeconds_Exponential(t *testing.T) {
	b := BackoffStrategy{
		Kind:        "exponential",
		BaseSeconds: intp(30),
		CapSeconds:  intp(3600),
	}
	cases := []struct {
		attempt int
		want    float64
	}{
		{1, 30},    // base * 2^0
		{2, 60},    // base * 2^1
		{3, 120},   // base * 2^2
		{4, 240},   // base * 2^3
		{8, 3600},  // would be 3840, clipped at cap
		{20, 3600}, // saturated at cap
	}
	for _, c := range cases {
		got := baseBackoffSeconds(b, c.attempt)
		if got != c.want {
			t.Errorf("attempt=%d: got %v, want %v", c.attempt, got, c.want)
		}
	}
}

// TestBaseBackoffSeconds_Fixed — SPEC §3.5.1, fixed case.
func TestBaseBackoffSeconds_Fixed(t *testing.T) {
	b := BackoffStrategy{Kind: "fixed", Seconds: intp(45)}
	for _, attempt := range []int{1, 2, 5, 100} {
		got := baseBackoffSeconds(b, attempt)
		if got != 45 {
			t.Errorf("attempt=%d: got %v, want 45", attempt, got)
		}
	}
}

// TestBaseBackoffSeconds_Defensive — defensive fallback when backoff fields are nil or kind is unknown.
func TestBaseBackoffSeconds_Defensive(t *testing.T) {
	cases := []struct {
		name string
		b    BackoffStrategy
	}{
		{"unknown kind", BackoffStrategy{Kind: "lognormal", Seconds: intp(10)}},
		{"exponential missing base", BackoffStrategy{Kind: "exponential", CapSeconds: intp(60)}},
		{"exponential missing cap", BackoffStrategy{Kind: "exponential", BaseSeconds: intp(10)}},
		{"fixed missing seconds", BackoffStrategy{Kind: "fixed"}},
		{"empty kind", BackoffStrategy{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := baseBackoffSeconds(c.b, 1)
			if got != 30 {
				t.Errorf("got %v, want 30 (defensive default)", got)
			}
		})
	}
}

// TestComputeRetryDelaySeconds_JitterInRange — SPEC §3.5.2.
func TestComputeRetryDelaySeconds_JitterInRange(t *testing.T) {
	const (
		samples = 1000
		base    = 60.0
	)
	b := BackoffStrategy{
		Kind:        "exponential",
		BaseSeconds: intp(int(base)),
		CapSeconds:  intp(int(base * 100)), // high cap so attempt=1 yields base
	}

	min := math.Inf(1)
	max := math.Inf(-1)
	for i := 0; i < samples; i++ {
		got := computeRetryDelaySeconds(b, 1) // attempt=1 → base
		if got < 0.5*base || got > 1.5*base {
			t.Fatalf("sample %d: got %v outside [%v, %v]", i, got, 0.5*base, 1.5*base)
		}
		if got < min {
			min = got
		}
		if got > max {
			max = got
		}
	}

	// With 1000 uniform samples we should see the empirical range cover most of the [0.5×, 1.5×] window.
	if min > 0.6*base {
		t.Errorf("min sample %v is too high; jitter not spreading downward (loose threshold 0.6×base = %v)", min, 0.6*base)
	}
	if max < 1.4*base {
		t.Errorf("max sample %v is too low; jitter not spreading upward (loose threshold 1.4×base = %v)", max, 1.4*base)
	}
}
