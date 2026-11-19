package queuecore

import (
	"encoding/json"
	"testing"
)

func TestEqualFingerprint_Matching(t *testing.T) {
	t.Parallel()
	base := 30
	cap := 3600
	p := CreateParams{
		Handler:     "send_email",
		Queue:       "mail",
		Priority:    5,
		MaxAttempts: 3,
		Backoff: BackoffStrategy{
			Kind:        "exponential",
			BaseSeconds: &base,
			CapSeconds:  &cap,
		},
		Payload: json.RawMessage(`{"to":"user@example.com","tags":["alert","ops"]}`),
	}
	existing := &Job{
		Handler:     "send_email",
		Queue:       "mail",
		Priority:    5,
		MaxAttempts: 3,
		Backoff: BackoffStrategy{
			Kind:        "exponential",
			BaseSeconds: &base,
			CapSeconds:  &cap,
		},
		// Whitespace and key order difference, same semantic JSON
		Payload: json.RawMessage(`{ "tags": [ "alert", "ops" ], "to": "user@example.com" }`),
	}

	if !equalFingerprint(p, existing) {
		t.Fatal("expected matching fingerprint for semantically identical payload")
	}
}

func TestEqualFingerprint_Mismatches(t *testing.T) {
	t.Parallel()
	base := 30
	cap := 3600
	baseJob := func() *Job {
		return &Job{
			Handler:     "send_email",
			Queue:       "mail",
			Priority:    5,
			MaxAttempts: 3,
			Backoff: BackoffStrategy{
				Kind:        "exponential",
				BaseSeconds: &base,
				CapSeconds:  &cap,
			},
			Payload: json.RawMessage(`{"to":"user@example.com"}`),
		}
	}

	// 1. Different handler
	p1 := CreateParams{
		Handler:     "send_sms",
		Priority:    5,
		MaxAttempts: 3,
		Backoff:     baseJob().Backoff,
		Payload:     baseJob().Payload,
	}
	if equalFingerprint(p1, baseJob()) {
		t.Fatal("expected mismatch on different handler")
	}

	// 2. Different payload
	p2 := CreateParams{
		Handler:     "send_email",
		Priority:    5,
		MaxAttempts: 3,
		Backoff:     baseJob().Backoff,
		Payload:     json.RawMessage(`{"to":"other@example.com"}`),
	}
	if equalFingerprint(p2, baseJob()) {
		t.Fatal("expected mismatch on different payload")
	}

	// 3. Different priority
	p3 := CreateParams{
		Handler:     "send_email",
		Priority:    9,
		MaxAttempts: 3,
		Backoff:     baseJob().Backoff,
		Payload:     baseJob().Payload,
	}
	if equalFingerprint(p3, baseJob()) {
		t.Fatal("expected mismatch on different priority")
	}

	// 4. Different max attempts
	p4 := CreateParams{
		Handler:     "send_email",
		Priority:    5,
		MaxAttempts: 10,
		Backoff:     baseJob().Backoff,
		Payload:     baseJob().Payload,
	}
	if equalFingerprint(p4, baseJob()) {
		t.Fatal("expected mismatch on different max attempts")
	}

	// 5. Different backoff
	diffBase := 60
	p5 := CreateParams{
		Handler:     "send_email",
		Priority:    5,
		MaxAttempts: 3,
		Backoff: BackoffStrategy{
			Kind:        "exponential",
			BaseSeconds: &diffBase,
			CapSeconds:  &cap,
		},
		Payload: baseJob().Payload,
	}
	if equalFingerprint(p5, baseJob()) {
		t.Fatal("expected mismatch on different backoff")
	}
}
