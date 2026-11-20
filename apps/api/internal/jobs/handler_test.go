package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type mockJobRepo struct {
	createFunc       func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error)
	retryFunc        func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error)
	replayDLQFunc    func(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error)
	listAttemptsFunc func(ctx context.Context, jobID string) ([]*queuecore.Attempt, error)
	listFunc         func(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error)
	countFunc        func(ctx context.Context, p queuecore.ListParams) (int, error)
}

type mockBroadcaster struct {
	dirty []string
}

func (m *mockBroadcaster) MarkDirty(resources ...string) {
	m.dirty = append(m.dirty, resources...)
}

func (m *mockJobRepo) Create(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
	if m.createFunc != nil {
		return m.createFunc(ctx, p)
	}
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Cancel(ctx context.Context, p queuecore.CancelParams) (*queuecore.Job, error) {
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Retry(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
	if m.retryFunc != nil {
		return m.retryFunc(ctx, p)
	}
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) ReplayDLQ(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error) {
	if m.replayDLQFunc != nil {
		return m.replayDLQFunc(ctx, p)
	}
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) GetByID(ctx context.Context, id string) (*queuecore.Job, error) {
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) List(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error) {
	if m.listFunc != nil {
		return m.listFunc(ctx, p)
	}
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Count(ctx context.Context, p queuecore.ListParams) (int, error) {
	if m.countFunc != nil {
		return m.countFunc(ctx, p)
	}
	return 0, errors.New("not implemented")
}

func (m *mockJobRepo) ListAttempts(ctx context.Context, jobID string) ([]*queuecore.Attempt, error) {
	if m.listAttemptsFunc != nil {
		return m.listAttemptsFunc(ctx, jobID)
	}
	return []*queuecore.Attempt{}, nil
}

func TestCreate_IdempotencyHeaderAccepted(t *testing.T) {
	t.Parallel()

	var capturedKey *string
	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			capturedKey = p.IdempotencyKey
			return &queuecore.Job{
				ID:           "01M7SNV6RX8QKSF3KZFAB9GM01",
				Handler:      p.Handler,
				Queue:        p.Queue,
				Priority:     p.Priority,
				MaxAttempts:  p.MaxAttempts,
				Status:       queuecore.StatusQueued,
				ScheduledFor: time.Now().UTC(),
				EnqueuedAt:   time.Now().UTC(),
				Payload:      p.Payload,
			}, nil
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler": "send_email",
		"queue":   "mail",
		"payload": map[string]string{"to": "user@example.com"},
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "header-key-12345")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d", resp.StatusCode)
	}

	if capturedKey == nil || *capturedKey != "header-key-12345" {
		t.Fatalf("expected IdempotencyKey 'header-key-12345', got %v", capturedKey)
	}
}

func TestCreate_IdempotencyHeaderBodyMismatch(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{}
	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler":        "send_email",
		"queue":          "mail",
		"payload":        map[string]string{"to": "user@example.com"},
		"idempotencyKey": "body-key-1",
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "header-key-2")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on mismatch, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(bodyResp), "do not match") {
		t.Fatalf("expected mismatch message, got %s", string(bodyResp))
	}
}

func TestCreate_IdempotentReplayHeader(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		isReplay       bool
		wantReplayHead string
	}{
		{
			name:           "Fresh creation does not have Idempotent-Replay header",
			isReplay:       false,
			wantReplayHead: "",
		},
		{
			name:           "Replay has Idempotent-Replay: true header",
			isReplay:       true,
			wantReplayHead: "true",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			repo := &mockJobRepo{
				createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
					return &queuecore.Job{
						ID:           "01M7SNV6RX8QKSF3KZFAB9GM01",
						Handler:      p.Handler,
						Queue:        p.Queue,
						Priority:     p.Priority,
						MaxAttempts:  p.MaxAttempts,
						Status:       queuecore.StatusQueued,
						ScheduledFor: time.Now().UTC(),
						EnqueuedAt:   time.Now().UTC(),
						Payload:      p.Payload,
						IsReplay:     tc.isReplay,
					}, nil
				},
			}

			h := NewHandler(repo)
			app := fiber.New()
			app.Post("/jobs", h.Create)

			body := map[string]any{
				"handler":        "send_email",
				"queue":          "mail",
				"payload":        map[string]string{"to": "user@example.com"},
				"idempotencyKey": "key-test",
			}
			payloadBytes, _ := json.Marshal(body)

			req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
			req.Header.Set("Content-Type", "application/json")

			resp, err := app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("expected 201 Created, got %d", resp.StatusCode)
			}

			gotHeader := resp.Header.Get("Idempotent-Replay")
			if gotHeader != tc.wantReplayHead {
				t.Fatalf("expected Idempotent-Replay=%q, got %q", tc.wantReplayHead, gotHeader)
			}

			var bodyRes struct {
				ID       string `json:"id"`
				IsReplay bool   `json:"isReplay"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&bodyRes); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if bodyRes.IsReplay != tc.isReplay {
				t.Fatalf("expected response body isReplay=%v, got %v", tc.isReplay, bodyRes.IsReplay)
			}
		})
	}
}

func TestCreate_IdempotencyConflictReturns409(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			return nil, queuecore.ErrIdempotencyConflict
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler":        "send_email",
		"queue":          "mail",
		"payload":        map[string]string{"to": "different@example.com"},
		"idempotencyKey": "key-reused",
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(bodyResp), "idempotency key conflict") {
		t.Fatalf("expected conflict error message, got %s", string(bodyResp))
	}
}

func TestCreate_InternalErrorSanitization(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			return nil, errors.New("pgx: fatal connection timeout at db.internal.net:5432: table jobs corrupted")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler": "send_email",
		"queue":   "mail",
		"payload": map[string]string{"to": "user@example.com"},
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	bodyStr := string(bodyResp)
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected generic 'internal server error', got %s", bodyStr)
	}
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "db.internal.net") {
		t.Fatalf("database details leaked in 500 response: %s", bodyStr)
	}
}

func TestCreate_BroadcasterNotification(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:           "01JOBNEW000000000000000001",
				Queue:        p.Queue,
				Handler:      p.Handler,
				Priority:     p.Priority,
				MaxAttempts:  p.MaxAttempts,
				Status:       queuecore.StatusQueued,
				ScheduledFor: time.Now().UTC(),
				EnqueuedAt:   time.Now().UTC(),
				Payload:      p.Payload,
			}, nil
		},
	}

	h := NewHandler(repo, broadcaster)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler": "http_request",
		"queue":   "default",
		"payload": map[string]string{"url": "https://example.com"},
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d", resp.StatusCode)
	}

	// Verify broadcaster MarkDirty was called with "jobs" and "stats"
	if len(broadcaster.dirty) != 2 || broadcaster.dirty[0] != "jobs" || broadcaster.dirty[1] != "stats" {
		t.Fatalf("expected broadcaster dirty ['jobs', 'stats'], got %v", broadcaster.dirty)
	}
}

func TestDeriveAPIStatus_ClockSkewTolerance(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()

	// 1. Immediate job where scheduledFor is slightly ahead due to clock skew (+100ms)
	skewAhead := now.Add(100 * time.Millisecond)
	if status := deriveAPIStatus(queuecore.StatusQueued, skewAhead, now); status != "queued" {
		t.Fatalf("expected 'queued' for 100ms clock skew ahead, got %q", status)
	}

	// 2. Immediate job where scheduledFor is at or in the past
	if status := deriveAPIStatus(queuecore.StatusQueued, now, now); status != "queued" {
		t.Fatalf("expected 'queued' for scheduledFor == now, got %q", status)
	}
	if status := deriveAPIStatus(queuecore.StatusQueued, now.Add(-10*time.Second), now); status != "queued" {
		t.Fatalf("expected 'queued' for past scheduledFor, got %q", status)
	}

	// 3. Truly future scheduled job (e.g. +1 minute)
	future := now.Add(1 * time.Minute)
	if status := deriveAPIStatus(queuecore.StatusQueued, future, now); status != "scheduled" {
		t.Fatalf("expected 'scheduled' for +1m future scheduled job, got %q", status)
	}

	// 4. Dead lettered status renamed
	if status := deriveAPIStatus(queuecore.StatusDeadLettered, now, now); status != "dead-lettered" {
		t.Fatalf("expected 'dead-lettered', got %q", status)
	}
}

func TestRetry_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	repo := &mockJobRepo{
		retryFunc: func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
			if p.JobID != "01M7SNV6RX8QKSF3KZFAB9GM99" {
				return nil, queuecore.ErrJobNotFound
			}
			return &queuecore.Job{
				ID:           p.JobID,
				Handler:      "send_email",
				Queue:        "mail",
				Priority:     5,
				MaxAttempts:  3,
				Attempt:      0,
				Status:       queuecore.StatusQueued,
				ScheduledFor: time.Now().UTC(),
				EnqueuedAt:   time.Now().UTC(),
				Payload:      json.RawMessage(`{}`),
			}, nil
		},
	}

	h := NewHandler(repo, broadcaster)
	app := fiber.New()
	app.Post("/jobs/:id/retry", h.Retry)

	req := httptest.NewRequest(http.MethodPost, "/jobs/01M7SNV6RX8QKSF3KZFAB9GM99/retry", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res jobResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.ID != "01M7SNV6RX8QKSF3KZFAB9GM99" {
		t.Fatalf("job id = %s, want 01M7SNV6RX8QKSF3KZFAB9GM99", res.ID)
	}
	if res.Status != "queued" {
		t.Fatalf("status = %s, want queued", res.Status)
	}
	if res.Attempt != 0 {
		t.Fatalf("attempt = %d, want 0", res.Attempt)
	}

	if len(broadcaster.dirty) != 2 || broadcaster.dirty[0] != "jobs" || broadcaster.dirty[1] != "stats" {
		t.Fatalf("expected broadcaster dirty ['jobs', 'stats'], got %v", broadcaster.dirty)
	}
}

func TestRetry_NotFound_404(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		retryFunc: func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
			return nil, queuecore.ErrJobNotFound
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/:id/retry", h.Retry)

	req := httptest.NewRequest(http.MethodPost, "/jobs/nonexistent/retry", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}
}

func TestRetry_NonRetryable_409(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		retryFunc: func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
			return nil, queuecore.ErrNotRetryable
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/:id/retry", h.Retry)

	req := httptest.NewRequest(http.MethodPost, "/jobs/running-job/retry", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "job is not retryable") {
		t.Fatalf("expected not retryable message, got %s", string(body))
	}
}

func TestRetry_InternalErrorSanitization(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		retryFunc: func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
			return nil, errors.New("pgx: fatal socket error to db.internal.cluster:5432")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/:id/retry", h.Retry)

	req := httptest.NewRequest(http.MethodPost, "/jobs/err-job/retry", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected sanitized error, got %s", bodyStr)
	}
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "db.internal.cluster") {
		t.Fatalf("leaked database info: %s", bodyStr)
	}
}

func TestReplayDLQ_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	repo := &mockJobRepo{
		replayDLQFunc: func(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error) {
			if p.Queue != "mail" || p.Handler != "send_email" || p.Limit != 50 {
				t.Errorf("unexpected params: %+v", p)
			}
			return []string{"01JOB1", "01JOB2"}, nil
		},
	}

	h := NewHandler(repo, broadcaster)
	app := fiber.New()
	app.Post("/jobs/dlq/replay", h.ReplayDLQ)

	bodyBytes, _ := json.Marshal(map[string]any{
		"queue":   "mail",
		"handler": "send_email",
		"limit":   50,
	})
	req := httptest.NewRequest(http.MethodPost, "/jobs/dlq/replay", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res replayDLQResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.ReplayedCount != 2 {
		t.Fatalf("replayedCount = %d, want 2", res.ReplayedCount)
	}
	if len(res.JobIDs) != 2 || res.JobIDs[0] != "01JOB1" || res.JobIDs[1] != "01JOB2" {
		t.Fatalf("jobIds = %v, want ['01JOB1', '01JOB2']", res.JobIDs)
	}

	if len(broadcaster.dirty) != 2 || broadcaster.dirty[0] != "jobs" || broadcaster.dirty[1] != "stats" {
		t.Fatalf("expected broadcaster dirty ['jobs', 'stats'], got %v", broadcaster.dirty)
	}
}

func TestReplayDLQ_EmptyNoBroadcast(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	repo := &mockJobRepo{
		replayDLQFunc: func(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error) {
			return []string{}, nil
		},
	}

	h := NewHandler(repo, broadcaster)
	app := fiber.New()
	app.Post("/jobs/dlq/replay", h.ReplayDLQ)

	req := httptest.NewRequest(http.MethodPost, "/jobs/dlq/replay", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res replayDLQResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.ReplayedCount != 0 {
		t.Fatalf("replayedCount = %d, want 0", res.ReplayedCount)
	}
	if len(broadcaster.dirty) != 0 {
		t.Fatalf("broadcaster should not be called when replayedCount is 0, got %v", broadcaster.dirty)
	}
}

func TestReplayDLQ_LimitValidation_400(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{}
	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/dlq/replay", h.ReplayDLQ)

	tests := []int{0, -5, 501, 1000}
	for _, l := range tests {
		bodyBytes, _ := json.Marshal(map[string]any{"limit": l})
		req := httptest.NewRequest(http.MethodPost, "/jobs/dlq/replay", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")

		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("limit=%d: expected 400 Bad Request, got %d", l, resp.StatusCode)
		}
	}
}

func TestReplayDLQ_MalformedJSON_400(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{}
	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/dlq/replay", h.ReplayDLQ)

	req := httptest.NewRequest(http.MethodPost, "/jobs/dlq/replay", bytes.NewReader([]byte("{invalid-json")))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on malformed JSON, got %d", resp.StatusCode)
	}
}

func TestReplayDLQ_InternalErrorSanitization(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		replayDLQFunc: func(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error) {
			return nil, errors.New("pgx: query execution timeout on table jobs at internal-db:5432")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/dlq/replay", h.ReplayDLQ)

	req := httptest.NewRequest(http.MethodPost, "/jobs/dlq/replay", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected sanitized error, got %s", bodyStr)
	}
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "internal-db") {
		t.Fatalf("leaked database details: %s", bodyStr)
	}
}

func TestJobRoutes_ScopeEnforcement(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		retryFunc: func(ctx context.Context, p queuecore.RetryParams) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:      p.JobID,
				Status:  queuecore.StatusQueued,
				Payload: json.RawMessage(`{}`),
			}, nil
		},
		replayDLQFunc: func(ctx context.Context, p queuecore.ReplayDLQParams) ([]string, error) {
			return []string{"01JOB1"}, nil
		},
	}

	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	h := NewHandler(repo)
	app := fiber.New()
	Register(app, h, authn)

	// 1. Unauthenticated requests should be 401
	for _, path := range []string{"/jobs", "/jobs/validate", "/jobs/01JOB/retry", "/jobs/dlq/replay"} {
		method := http.MethodPost
		if path == "/jobs" {
			method = http.MethodGet
		}
		req := httptest.NewRequest(method, path, bytes.NewReader([]byte("{}")))
		req.Header.Set("Content-Type", "application/json")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated: expected 401, got %d", path, resp.StatusCode)
		}
	}
}

func TestList_WorkerIDFilter_Success(t *testing.T) {
	t.Parallel()

	var capturedParams queuecore.ListParams
	repo := &mockJobRepo{
		listFunc: func(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error) {
			capturedParams = p
			return []*queuecore.Job{
				{
					ID:           "01JOBWORKER0000000000000001",
					Handler:      "http_request",
					Queue:        "default",
					Priority:     5,
					MaxAttempts:  3,
					Status:       queuecore.StatusRunning,
					ScheduledFor: time.Now().UTC(),
					EnqueuedAt:   time.Now().UTC(),
					Payload:      json.RawMessage(`{}`),
				},
			}, nil
		},
		countFunc: func(ctx context.Context, p queuecore.ListParams) (int, error) {
			return 1, nil
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Get("/jobs", h.List)

	// 1. Using snake_case worker_id
	req1 := httptest.NewRequest(http.MethodGet, "/jobs?worker_id=01TESTWORKER0000000000001", nil)
	resp1, err := app.Test(req1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp1.Body.Close() }()

	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp1.StatusCode)
	}
	if capturedParams.WorkerID != "01TESTWORKER0000000000001" {
		t.Fatalf("expected captured worker_id '01TESTWORKER0000000000001', got %q", capturedParams.WorkerID)
	}

	var body1 struct {
		Jobs       []map[string]any `json:"jobs"`
		TotalCount int              `json:"totalCount"`
		Limit      int              `json:"limit"`
		Offset     int              `json:"offset"`
	}
	if err := json.NewDecoder(resp1.Body).Decode(&body1); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body1.Jobs) != 1 || body1.TotalCount != 1 {
		t.Fatalf("expected 1 job and totalCount=1, got jobs=%d totalCount=%d", len(body1.Jobs), body1.TotalCount)
	}

	// 2. Using camelCase workerId alias
	req2 := httptest.NewRequest(http.MethodGet, "/jobs?workerId=01TESTWORKER0000000000001", nil)
	resp2, err := app.Test(req2)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for workerId, got %d", resp2.StatusCode)
	}
	if capturedParams.WorkerID != "01TESTWORKER0000000000001" {
		t.Fatalf("expected captured worker_id '01TESTWORKER0000000000001', got %q", capturedParams.WorkerID)
	}
}

func TestList_WorkerIDFilter_Conflict_400(t *testing.T) {
	t.Parallel()

	h := NewHandler(&mockJobRepo{})
	app := fiber.New()
	app.Get("/jobs", h.List)

	// Both worker_id and workerId provided, but with differing values
	req := httptest.NewRequest(http.MethodGet, "/jobs?worker_id=worker-alpha&workerId=worker-beta", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for conflicting params, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "do not match") {
		t.Fatalf("expected mismatch error message, got: %s", string(body))
	}
}

func TestList_WorkerIDFilter_MatchingBoth_200(t *testing.T) {
	t.Parallel()

	var captured string
	repo := &mockJobRepo{
		listFunc: func(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error) {
			captured = p.WorkerID
			return []*queuecore.Job{}, nil
		},
		countFunc: func(ctx context.Context, p queuecore.ListParams) (int, error) {
			return 0, nil
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Get("/jobs", h.List)

	// Both worker_id and workerId provided with identical values
	req := httptest.NewRequest(http.MethodGet, "/jobs?worker_id=worker-same&workerId=worker-same", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK when both match, got %d", resp.StatusCode)
	}
	if captured != "worker-same" {
		t.Fatalf("expected worker-same, got %q", captured)
	}
}

func TestList_WorkerIDFilter_ValidationErrors_400(t *testing.T) {
	t.Parallel()

	h := NewHandler(&mockJobRepo{})
	app := fiber.New()
	app.Get("/jobs", h.List)

	// Overly long worker ID (> 128 characters)
	tooLong := strings.Repeat("w", 129)
	req1 := httptest.NewRequest(http.MethodGet, "/jobs?worker_id="+tooLong, nil)
	resp1, err := app.Test(req1)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp1.Body.Close()
	if resp1.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for overly long worker_id, got %d", resp1.StatusCode)
	}

	// Invalid characters (spaces / control chars)
	req2 := httptest.NewRequest(http.MethodGet, "/jobs?worker_id=bad%20worker%20id", nil)
	resp2, err := app.Test(req2)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for spaces in worker_id, got %d", resp2.StatusCode)
	}
}

func TestList_InternalErrorSanitization(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		listFunc: func(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error) {
			return nil, errors.New("pgx: fatal connection pool exhaust at internal-db.cluster:5432")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Get("/jobs", h.List)

	req := httptest.NewRequest(http.MethodGet, "/jobs?worker_id=worker-test", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 Internal Server Error, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected sanitized error, got %s", bodyStr)
	}
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "internal-db.cluster") {
		t.Fatalf("database details leaked in 500 response: %s", bodyStr)
	}
}

func TestValidate_SuccessZeroDBCalls(t *testing.T) {
	t.Parallel()

	dbCalled := false
	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			dbCalled = true
			return nil, errors.New("should not be called")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs/validate", h.Validate)

	payload := map[string]any{
		"handler":     "http_request",
		"queue":       "notifications",
		"payload":     map[string]any{"url": "https://example.com"},
		"priority":    3,
		"maxAttempts": 5,
		"backoff": map[string]any{
			"kind":        "exponential",
			"baseSeconds": 10,
			"capSeconds":  300,
		},
		"idempotencyKey": "test-key-123",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "test-key-123")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res struct {
		Valid bool   `json:"valid"`
		Error string `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !res.Valid {
		t.Fatalf("expected valid=true, got valid=false (error: %s)", res.Error)
	}
	if dbCalled {
		t.Fatal("expected zero database calls during dry-run validation")
	}
}

func TestValidate_ValidationErrors(t *testing.T) {
	t.Parallel()

	h := NewHandler(&mockJobRepo{})
	app := fiber.New()
	app.Post("/jobs/validate", h.Validate)

	tests := []struct {
		name          string
		body          any
		headerKey     string
		wantSubstring string
	}{
		{
			name:          "invalid JSON syntax",
			body:          `{"handler": `,
			wantSubstring: "invalid JSON body",
		},
		{
			name: "missing handler",
			body: map[string]any{
				"queue":   "default",
				"payload": map[string]any{"foo": "bar"},
			},
			wantSubstring: "handler is required",
		},
		{
			name: "missing queue",
			body: map[string]any{
				"handler": "http_request",
				"payload": map[string]any{"foo": "bar"},
			},
			wantSubstring: "queue is required",
		},
		{
			name: "missing payload",
			body: map[string]any{
				"handler": "http_request",
				"queue":   "default",
			},
			wantSubstring: "payload is required",
		},
		{
			name: "priority below 0",
			body: map[string]any{
				"handler":  "http_request",
				"queue":    "default",
				"payload":  map[string]any{"foo": "bar"},
				"priority": -1,
			},
			wantSubstring: "priority must be between 0 and 9",
		},
		{
			name: "priority above 9",
			body: map[string]any{
				"handler":  "http_request",
				"queue":    "default",
				"payload":  map[string]any{"foo": "bar"},
				"priority": 10,
			},
			wantSubstring: "priority must be between 0 and 9",
		},
		{
			name: "maxAttempts below 1",
			body: map[string]any{
				"handler":     "http_request",
				"queue":       "default",
				"payload":     map[string]any{"foo": "bar"},
				"maxAttempts": 0,
			},
			wantSubstring: "maxAttempts must be >= 1",
		},
		{
			name: "invalid backoff baseSeconds",
			body: map[string]any{
				"handler": "http_request",
				"queue":   "default",
				"payload": map[string]any{"foo": "bar"},
				"backoff": map[string]any{
					"kind":        "exponential",
					"baseSeconds": 0,
					"capSeconds":  60,
				},
			},
			wantSubstring: "must be positive",
		},
		{
			name: "idempotency key mismatch",
			body: map[string]any{
				"handler":        "http_request",
				"queue":          "default",
				"payload":        map[string]any{"foo": "bar"},
				"idempotencyKey": "key-body",
			},
			headerKey:     "key-header",
			wantSubstring: "do not match",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var bodyReader io.Reader
			if s, ok := tc.body.(string); ok {
				bodyReader = strings.NewReader(s)
			} else {
				b, _ := json.Marshal(tc.body)
				bodyReader = bytes.NewReader(b)
			}

			req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bodyReader)
			req.Header.Set("Content-Type", "application/json")
			if tc.headerKey != "" {
				req.Header.Set("Idempotency-Key", tc.headerKey)
			}

			resp, err := app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400 Bad Request, got %d", resp.StatusCode)
			}

			var res struct {
				Valid bool   `json:"valid"`
				Error string `json:"error"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if res.Valid {
				t.Fatal("expected valid=false, got valid=true")
			}
			if !strings.Contains(res.Error, tc.wantSubstring) {
				t.Fatalf("expected error containing %q, got %q", tc.wantSubstring, res.Error)
			}
		})
	}
}

func TestValidate_AuthScopeEnforcement(t *testing.T) {
	t.Parallel()

	h := NewHandler(&mockJobRepo{})
	app := fiber.New()

	app.Use(func(c fiber.Ctx) error {
		if header := c.Get("X-Test-Scopes"); header != "" {
			scopes := strings.Split(header, ",")
			p := auth.Principal{
				ID:     "test-principal",
				Kind:   "api_key",
				Scopes: scopes,
			}
			c.SetContext(auth.ContextWithPrincipal(c.Context(), p))
		}
		return c.Next()
	})

	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	Register(app, h, authn)

	validPayload := map[string]any{
		"handler": "http_request",
		"queue":   "default",
		"payload": map[string]any{"foo": "bar"},
	}
	body, _ := json.Marshal(validPayload)

	// 1. Unauthenticated -> 401
	{
		req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got %d", resp.StatusCode)
		}
	}

	// 2. Read-only scope -> 403 Forbidden
	{
		req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Scopes", auth.ScopeJobsRead)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden, got %d", resp.StatusCode)
		}
	}

	// 3. jobs:write scope -> 200 OK
	{
		req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
		}
	}
}

func TestValidateCallbackURL(t *testing.T) {
	// Valid HTTP and HTTPS
	validURLs := []string{
		"http://example.com/webhook",
		"https://api.my-service.internal/callbacks/job-finished",
		"https://example.com:8443/webhook?token=secret#frag",
	}
	for _, raw := range validURLs {
		res, err := validateCallbackURL(raw)
		if err != nil {
			t.Errorf("validateCallbackURL(%q): unexpected err: %v", raw, err)
		}
		if res != raw {
			t.Errorf("validateCallbackURL(%q) = %q; want %q", raw, res, raw)
		}
	}

	// Empty string
	res, err := validateCallbackURL("   ")
	if err != nil || res != "" {
		t.Errorf("expected empty string and nil error for whitespace URL, got %q, %v", res, err)
	}

	// Invalid schemes
	invalidURLs := []string{
		"ftp://example.com/file",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"example.com/webhook",
		"http://",
		"https://",
	}
	for _, raw := range invalidURLs {
		_, err := validateCallbackURL(raw)
		if err == nil {
			t.Errorf("validateCallbackURL(%q): expected error, got nil", raw)
		}
	}

	// Too long
	tooLong := "https://example.com/" + strings.Repeat("a", 2050)
	if _, err := validateCallbackURL(tooLong); err == nil {
		t.Errorf("expected error for URL exceeding 2048 chars, got nil")
	}
}

func TestJobsValidate_CallbackURL(t *testing.T) {
	t.Parallel()

	h := NewHandler(&mockJobRepo{})
	app := fiber.New()

	app.Use(func(c fiber.Ctx) error {
		if header := c.Get("X-Test-Scopes"); header != "" {
			scopes := strings.Split(header, ",")
			p := auth.Principal{
				ID:     "test-principal",
				Kind:   "api_key",
				Scopes: scopes,
			}
			c.SetContext(auth.ContextWithPrincipal(c.Context(), p))
		}
		return c.Next()
	})

	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	Register(app, h, authn)

	// 1. Valid callback URL -> 200 OK
	{
		body, _ := json.Marshal(map[string]any{
			"handler":     "http_request",
			"queue":       "default",
			"payload":     map[string]any{"foo": "bar"},
			"callbackUrl": "https://example.com/webhook",
		})
		req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK for valid callbackUrl, got %d", resp.StatusCode)
		}
	}

	// 2. Invalid callback URL -> 400 Bad Request
	{
		body, _ := json.Marshal(map[string]any{
			"handler":     "http_request",
			"queue":       "default",
			"payload":     map[string]any{"foo": "bar"},
			"callbackUrl": "ftp://example.com/webhook",
		})
		req := httptest.NewRequest(http.MethodPost, "/jobs/validate", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400 Bad Request for invalid callbackUrl, got %d", resp.StatusCode)
		}
	}
}
