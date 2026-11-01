package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// jobWith builds a job whose payload is the marshaled httpRequestPayload-ish map.
func jobWith(t *testing.T, payload map[string]any) *queuecore.Job {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return &queuecore.Job{ID: "j-test", Handler: "http_request", Payload: raw}
}

func TestHTTPRequest_Success_RichResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	result, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL}))
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	var got map[string]any
	if e := json.Unmarshal(result, &got); e != nil {
		t.Fatalf("result not JSON: %v", e)
	}
	if got["statusCode"] != float64(200) {
		t.Errorf("statusCode = %v; want 200", got["statusCode"])
	}
	if got["contentType"] != "application/json" {
		t.Errorf("contentType = %v; want application/json", got["contentType"])
	}
	if got["responseExcerpt"] != `{"ok":true}` {
		t.Errorf("responseExcerpt = %v; want the body", got["responseExcerpt"])
	}
	if _, ok := got["durationMs"]; !ok {
		t.Error("result missing durationMs")
	}
}

func TestHTTPRequest_SendsMethodHeadersBody(t *testing.T) {
	var gotMethod, gotHeader, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHeader = r.Header.Get("X-Custom")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{
		"url":     srv.URL,
		"method":  "put",
		"headers": map[string]string{"X-Custom": "abc"},
		"body":    "hello-body",
	}))
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q; want PUT", gotMethod)
	}
	if gotHeader != "abc" {
		t.Errorf("X-Custom = %q; want abc", gotHeader)
	}
	if gotBody != "hello-body" {
		t.Errorf("body = %q; want hello-body", gotBody)
	}
}

func TestHTTPRequest_InjectsDeliveryHeaders(t *testing.T) {
	var jobID, attempt, idem string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jobID = r.Header.Get("X-Veyra-Job-Id")
		attempt = r.Header.Get("X-Veyra-Attempt")
		idem = r.Header.Get("Idempotency-Key")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	job := &queuecore.Job{ID: "01JOBULID", Handler: "http_request", Attempt: 3}
	raw, _ := json.Marshal(map[string]any{"url": srv.URL})
	job.Payload = raw
	if _, err := h.Handle(context.Background(), job); err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	if jobID != "01JOBULID" {
		t.Errorf("X-Veyra-Job-Id = %q; want 01JOBULID", jobID)
	}
	if attempt != "3" {
		t.Errorf("X-Veyra-Attempt = %q; want 3", attempt)
	}
	if idem != "01JOBULID" {
		t.Errorf("Idempotency-Key = %q; want job id default 01JOBULID", idem)
	}
}

func TestHTTPRequest_RespectsCallerIdempotencyKey(t *testing.T) {
	var idem, jobID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idem = r.Header.Get("Idempotency-Key")
		jobID = r.Header.Get("X-Veyra-Job-Id")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	job := &queuecore.Job{ID: "01JOBULID", Handler: "http_request", Attempt: 1}
	raw, _ := json.Marshal(map[string]any{
		"url":     srv.URL,
		"headers": map[string]string{"Idempotency-Key": "caller-key"},
	})
	job.Payload = raw
	if _, err := h.Handle(context.Background(), job); err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	if idem != "caller-key" {
		t.Errorf("Idempotency-Key = %q; want caller-provided caller-key (not overwritten)", idem)
	}
	// X-Veyra-Job-Id is always Veyra's, regardless of caller idempotency key.
	if jobID != "01JOBULID" {
		t.Errorf("X-Veyra-Job-Id = %q; want 01JOBULID", jobID)
	}
}

func TestHTTPRequest_5xx_FailsRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL}))
	assertErrorClass(t, err, "http_5xx")
	assertPermanent(t, err, false)
}

func TestHTTPRequest_4xx_Permanent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL}))
	assertErrorClass(t, err, "http_4xx")
	assertPermanent(t, err, true)
}

func TestHTTPRequest_408_Retryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestTimeout)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL}))
	assertErrorClass(t, err, "http_4xx")
	assertPermanent(t, err, false)
}

func TestHTTPRequest_429_Retryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL}))
	assertErrorClass(t, err, "http_4xx")
	assertPermanent(t, err, false)
}

func TestHTTPRequest_Timeout(t *testing.T) {
	// Server sleeps longer than the request's timeoutSeconds, so the
	// per-request deadline (reqCtx) fires while the job context stays alive.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	timeoutSeconds := 1
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": srv.URL, "timeoutSeconds": timeoutSeconds}))
	assertErrorClass(t, err, "timeout")
}

func TestHTTPRequest_ConnectionRefused(t *testing.T) {
	// Bind then immediately close to get a port nothing is listening on.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	h := NewHTTPRequest()
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"url": url}))
	assertErrorClass(t, err, "connection_refused")
}

func TestHTTPRequest_InvalidPayload(t *testing.T) {
	h := NewHTTPRequest()
	// missing url
	_, err := h.Handle(context.Background(), jobWith(t, map[string]any{"method": "GET"}))
	assertErrorClass(t, err, "invalid_payload")
	assertPermanent(t, err, true)

	// non-positive timeout
	_, err = h.Handle(context.Background(), jobWith(t, map[string]any{"url": "http://example.invalid", "timeoutSeconds": 0}))
	assertErrorClass(t, err, "invalid_payload")
	assertPermanent(t, err, true)
}

func TestHTTPRequest_JobCtxCancelled_NotAHandlerFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := NewHTTPRequest()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()

	_, err := h.Handle(ctx, jobWith(t, map[string]any{"url": srv.URL, "timeoutSeconds": 30}))
	// Must surface as context.Canceled (runtime takes the reclaim path), NOT a
	// classified *handler.Error.
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v; want context.Canceled", err)
	}
	var herr *Error
	if errors.As(err, &herr) {
		t.Fatalf("cancellation should not be a *handler.Error, got class=%q", herr.Class)
	}
}

func assertErrorClass(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error of class %q, got nil", want)
	}
	var herr *Error
	if !errors.As(err, &herr) {
		t.Fatalf("err %v is not *handler.Error", err)
	}
	if herr.Class != want {
		t.Fatalf("error class = %q; want %q (msg: %s)", herr.Class, want, herr.Message)
	}
}

func assertPermanent(t *testing.T, err error, want bool) {
	t.Helper()
	var herr *Error
	if !errors.As(err, &herr) {
		t.Fatalf("err %v is not *handler.Error", err)
	}
	if herr.Permanent != want {
		t.Fatalf("Permanent = %v; want %v (class=%s)", herr.Permanent, want, herr.Class)
	}
}
