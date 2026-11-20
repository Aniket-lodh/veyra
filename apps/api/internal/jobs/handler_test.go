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
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Count(ctx context.Context, p queuecore.ListParams) (int, error) {
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
	for _, path := range []string{"/jobs/01JOB/retry", "/jobs/dlq/replay"} {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte("{}")))
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
