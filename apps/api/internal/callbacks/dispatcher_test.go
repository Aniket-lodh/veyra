package callbacks

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestComputeCallbackBackoffSeconds(t *testing.T) {
	cases := []struct {
		attempt int
		want    int
	}{
		{attempt: 1, want: 5},
		{attempt: 2, want: 15},
		{attempt: 3, want: 45},
		{attempt: 4, want: 135},
		{attempt: 5, want: 135},
	}
	for _, tc := range cases {
		got := computeCallbackBackoffSeconds(tc.attempt)
		if got != tc.want {
			t.Errorf("computeCallbackBackoffSeconds(%d) = %d; want %d", tc.attempt, got, tc.want)
		}
	}
}

func TestIsNonRetryableStatus(t *testing.T) {
	cases := []struct {
		code int
		want bool
	}{
		{code: 200, want: false},
		{code: 201, want: false},
		{code: 204, want: false},
		{code: 400, want: true},
		{code: 401, want: true},
		{code: 403, want: true},
		{code: 404, want: true},
		{code: 422, want: true},
		{code: 408, want: false}, // Request timeout: retryable
		{code: 429, want: false}, // Too many requests: retryable
		{code: 500, want: false},
		{code: 502, want: false},
		{code: 503, want: false},
	}
	for _, tc := range cases {
		got := isNonRetryableStatus(tc.code)
		if got != tc.want {
			t.Errorf("isNonRetryableStatus(%d) = %v; want %v", tc.code, got, tc.want)
		}
	}
}

func TestComputeSignature(t *testing.T) {
	secret := "test-secret"
	payload := []byte(`{"event":"job.completed"}`)
	sig := computeSignature(secret, payload)
	if len(sig) <= 7 || sig[:7] != "sha256=" {
		t.Fatalf("expected sha256= prefix, got %q", sig)
	}

	// Identical payload and secret produces identical signature.
	sig2 := computeSignature(secret, payload)
	if sig != sig2 {
		t.Fatalf("expected deterministic signature, got %q vs %q", sig, sig2)
	}

	// Different payload produces different signature.
	sig3 := computeSignature(secret, []byte(`{"event":"different"}`))
	if sig == sig3 {
		t.Fatalf("expected different signature for different payload")
	}
}

func TestDeliver_HeadersAndPayload(t *testing.T) {
	var receivedHeaders http.Header
	var receivedBody []byte

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		var err error
		receivedBody, err = io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"received":true}`))
	}))
	defer server.Close()

	d := NewDispatcher(nil, Config{
		Timeout:     5 * time.Second,
		Concurrency: 2,
		Secret:      "webhook-secret-123",
	})
	d.SetHTTPClient(server.Client())

	started := time.Now().Add(-10 * time.Second)
	completed := time.Now()

	job := claimedJob{
		ID:               "01JABCDEF0123456789",
		CallbackURL:      server.URL,
		CallbackAttempts: 1,
		Status:           "succeeded",
		Handler:          "custom_worker",
		Queue:            "emails",
		Attempt:          1,
		MaxAttempts:      3,
		Payload:          json.RawMessage(`{"recipient":"alice@example.com"}`),
		Result:           json.RawMessage(`{"sent":true}`),
		EnqueuedAt:       started.Add(-5 * time.Second),
		StartedAt:        &started,
		CompletedAt:      &completed,
	}

	// In test, since pool is nil, recordDelivered will fail gracefully without panicking.
	d.deliver(context.Background(), job)

	// Validate Headers
	if receivedHeaders.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q; want application/json", receivedHeaders.Get("Content-Type"))
	}
	if receivedHeaders.Get("User-Agent") != "Veyra-Webhook/1.0" {
		t.Errorf("User-Agent = %q; want Veyra-Webhook/1.0", receivedHeaders.Get("User-Agent"))
	}
	if receivedHeaders.Get("X-Veyra-Event") != "job.completed" {
		t.Errorf("X-Veyra-Event = %q; want job.completed", receivedHeaders.Get("X-Veyra-Event"))
	}
	if receivedHeaders.Get("X-Veyra-Job-Id") != job.ID {
		t.Errorf("X-Veyra-Job-Id = %q; want %s", receivedHeaders.Get("X-Veyra-Job-Id"), job.ID)
	}
	if receivedHeaders.Get("X-Veyra-Status") != "succeeded" {
		t.Errorf("X-Veyra-Status = %q; want succeeded", receivedHeaders.Get("X-Veyra-Status"))
	}
	if receivedHeaders.Get("X-Veyra-Attempt") != "1" {
		t.Errorf("X-Veyra-Attempt = %q; want 1", receivedHeaders.Get("X-Veyra-Attempt"))
	}
	if receivedHeaders.Get("X-Veyra-Delivery-Attempt") != "1" {
		t.Errorf("X-Veyra-Delivery-Attempt = %q; want 1", receivedHeaders.Get("X-Veyra-Delivery-Attempt"))
	}
	if receivedHeaders.Get("X-Veyra-Timestamp") == "" {
		t.Errorf("X-Veyra-Timestamp is empty")
	}

	sigHeader := receivedHeaders.Get("X-Veyra-Signature")
	expectedSig := computeSignature("webhook-secret-123", receivedBody)
	if sigHeader != expectedSig {
		t.Errorf("X-Veyra-Signature = %q; want %q", sigHeader, expectedSig)
	}

	// Validate Body JSON
	var parsed WebhookPayload
	if err := json.Unmarshal(receivedBody, &parsed); err != nil {
		t.Fatalf("failed to unmarshal delivered payload: %v", err)
	}
	if parsed.Event != "job.completed" {
		t.Errorf("parsed.Event = %q; want job.completed", parsed.Event)
	}
	if parsed.JobID != job.ID {
		t.Errorf("parsed.JobID = %q; want %s", parsed.JobID, job.ID)
	}
	if parsed.Queue != "emails" {
		t.Errorf("parsed.Queue = %q; want emails", parsed.Queue)
	}
	if parsed.Handler != "custom_worker" {
		t.Errorf("parsed.Handler = %q; want custom_worker", parsed.Handler)
	}
	if parsed.Status != "succeeded" {
		t.Errorf("parsed.Status = %q; want succeeded", parsed.Status)
	}
}
