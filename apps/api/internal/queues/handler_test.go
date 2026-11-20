package queues

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

type mockQueueRepo struct {
	pauseFunc    func(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error)
	resumeFunc   func(ctx context.Context, p queuecore.ResumeQueueParams) (*queuecore.QueueState, error)
	getStateFunc func(ctx context.Context, queueName string) (*queuecore.QueueState, error)
}

func (m *mockQueueRepo) PauseQueue(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error) {
	if m.pauseFunc != nil {
		return m.pauseFunc(ctx, p)
	}
	now := time.Now()
	var reason *string
	if p.Reason != "" {
		reason = &p.Reason
	}
	return &queuecore.QueueState{
		QueueName:    p.QueueName,
		Paused:       true,
		PausedAt:     &now,
		PausedReason: reason,
		UpdatedAt:    now,
	}, nil
}

func (m *mockQueueRepo) ResumeQueue(ctx context.Context, p queuecore.ResumeQueueParams) (*queuecore.QueueState, error) {
	if m.resumeFunc != nil {
		return m.resumeFunc(ctx, p)
	}
	return &queuecore.QueueState{
		QueueName: p.QueueName,
		Paused:    false,
		UpdatedAt: time.Now(),
	}, nil
}

func (m *mockQueueRepo) GetQueueState(ctx context.Context, queueName string) (*queuecore.QueueState, error) {
	if m.getStateFunc != nil {
		return m.getStateFunc(ctx, queueName)
	}
	return &queuecore.QueueState{
		QueueName: queueName,
		Paused:    false,
	}, nil
}

type mockBroadcaster struct {
	resources []string
}

func (m *mockBroadcaster) MarkDirty(resources ...string) {
	m.resources = append(m.resources, resources...)
}

func setupTestApp(repo queueRepository, broadcaster eventBroadcaster) (*fiber.App, *auth.Authenticator) {
	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	h := NewHandler(repo, broadcaster)
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

	Register(app, h, authn)
	return app, authn
}

func TestQueues_Pause_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	var capturedParams queuecore.PauseQueueParams
	repo := &mockQueueRepo{
		pauseFunc: func(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error) {
			capturedParams = p
			now := time.Now().UTC()
			reason := p.Reason
			return &queuecore.QueueState{
				QueueName:    p.QueueName,
				Paused:       true,
				PausedAt:     &now,
				PausedReason: &reason,
				UpdatedAt:    now,
			}, nil
		},
	}

	app, _ := setupTestApp(repo, broadcaster)

	body := bytes.NewBufferString(`{"reason":"Database migration in progress"}`)
	req := httptest.NewRequest(http.MethodPost, "/queues/emails/pause", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 OK, got %d: %s", resp.StatusCode, string(raw))
	}

	if capturedParams.QueueName != "emails" {
		t.Errorf("expected queue emails, got %q", capturedParams.QueueName)
	}
	if capturedParams.Reason != "Database migration in progress" {
		t.Errorf("expected reason 'Database migration in progress', got %q", capturedParams.Reason)
	}

	var res queueStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !res.Paused || res.Queue != "emails" || res.PausedReason == nil || *res.PausedReason != "Database migration in progress" {
		t.Fatalf("unexpected response payload: %+v", res)
	}

	if len(broadcaster.resources) == 0 {
		t.Errorf("expected live broadcaster to be called")
	}
}

func TestQueues_RePause_PreservesReason(t *testing.T) {
	t.Parallel()

	storedState := &queuecore.QueueState{
		QueueName:    "emails",
		Paused:       true,
		PausedReason: func() *string { s := "Initial reason"; return &s }(),
		UpdatedAt:    time.Now().UTC(),
	}

	repo := &mockQueueRepo{
		pauseFunc: func(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error) {
			if p.Reason != "" {
				storedState.PausedReason = &p.Reason
			}
			storedState.UpdatedAt = time.Now().UTC()
			return storedState, nil
		},
	}

	app, _ := setupTestApp(repo, nil)

	// Call pause without body on already paused queue
	req := httptest.NewRequest(http.MethodPost, "/queues/emails/pause", nil)
	req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res queueStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !res.Paused || res.PausedReason == nil || *res.PausedReason != "Initial reason" {
		t.Fatalf("expected reason 'Initial reason' to be preserved, got: %+v", res)
	}
}

func TestQueues_Resume_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	var capturedParams queuecore.ResumeQueueParams
	repo := &mockQueueRepo{
		resumeFunc: func(ctx context.Context, p queuecore.ResumeQueueParams) (*queuecore.QueueState, error) {
			capturedParams = p
			now := time.Now().UTC()
			return &queuecore.QueueState{
				QueueName: p.QueueName,
				Paused:    false,
				UpdatedAt: now,
			}, nil
		},
	}

	app, _ := setupTestApp(repo, broadcaster)

	req := httptest.NewRequest(http.MethodPost, "/queues/default/resume", nil)
	req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 OK, got %d: %s", resp.StatusCode, string(raw))
	}

	if capturedParams.QueueName != "default" {
		t.Errorf("expected queue default, got %q", capturedParams.QueueName)
	}

	var res queueStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.Paused || res.Queue != "default" || res.PausedAt != nil || res.PausedReason != nil {
		t.Fatalf("unexpected resume payload: %+v", res)
	}
}

func TestQueues_URLDecoding(t *testing.T) {
	t.Parallel()

	var capturedQueue string
	repo := &mockQueueRepo{
		pauseFunc: func(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error) {
			capturedQueue = p.QueueName
			now := time.Now().UTC()
			return &queuecore.QueueState{
				QueueName: p.QueueName,
				Paused:    true,
				UpdatedAt: now,
			}, nil
		},
	}

	app, _ := setupTestApp(repo, nil)

	req := httptest.NewRequest(http.MethodPost, "/queues/high%2Dpriority/pause", nil)
	req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	if capturedQueue != "high-priority" {
		t.Fatalf("expected high-priority, got %q", capturedQueue)
	}
}

func TestQueues_ValidationErrors(t *testing.T) {
	t.Parallel()

	app, _ := setupTestApp(&mockQueueRepo{}, nil)

	testCases := []struct {
		name       string
		path       string
		body       string
		wantStatus int
	}{
		{
			name:       "whitespace only queue",
			path:       "/queues/%20%20/pause",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "queue with spaces",
			path:       "/queues/my%20queue/pause",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "queue with control chars",
			path:       "/queues/my%0Aqueue/pause",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "queue name too long",
			path:       "/queues/" + strings.Repeat("a", 130) + "/pause",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "malformed json body",
			path:       "/queues/valid-queue/pause",
			body:       "{not-json}",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyReader io.Reader
			if tc.body != "" {
				bodyReader = bytes.NewBufferString(tc.body)
			}
			req := httptest.NewRequest(http.MethodPost, tc.path, bodyReader)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("app.Test failed: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode != tc.wantStatus {
				raw, _ := io.ReadAll(resp.Body)
				t.Fatalf("expected %d, got %d: %s", tc.wantStatus, resp.StatusCode, string(raw))
			}

			var bodyMap map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&bodyMap); err != nil {
				t.Fatalf("decode json error: %v", err)
			}
			if _, ok := bodyMap["error"]; !ok {
				t.Fatalf("expected 'error' field in response body")
			}
		})
	}
}

func TestQueues_AuthScopesEnforced(t *testing.T) {
	t.Parallel()

	app, _ := setupTestApp(&mockQueueRepo{}, nil)

	paths := []string{
		"/queues/default/pause",
		"/queues/default/resume",
	}

	for _, path := range paths {
		// 1. Unauthenticated -> 401
		reqUnauth := httptest.NewRequest(http.MethodPost, path, nil)
		respUnauth, err := app.Test(reqUnauth)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		_ = respUnauth.Body.Close()
		if respUnauth.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated: expected 401, got %d", path, respUnauth.StatusCode)
		}

		// 2. Insufficient scope (jobs:read) -> 403
		reqReadOnly := httptest.NewRequest(http.MethodPost, path, nil)
		reqReadOnly.Header.Set("X-Test-Scopes", auth.ScopeJobsRead)
		respReadOnly, err := app.Test(reqReadOnly)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		_ = respReadOnly.Body.Close()
		if respReadOnly.StatusCode != http.StatusForbidden {
			t.Fatalf("%s read-only: expected 403, got %d", path, respReadOnly.StatusCode)
		}

		// 3. Insufficient scope (queue:read) -> 403
		reqQueueRead := httptest.NewRequest(http.MethodPost, path, nil)
		reqQueueRead.Header.Set("X-Test-Scopes", auth.ScopeQueueRead)
		respQueueRead, err := app.Test(reqQueueRead)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		_ = respQueueRead.Body.Close()
		if respQueueRead.StatusCode != http.StatusForbidden {
			t.Fatalf("%s queue:read: expected 403, got %d", path, respQueueRead.StatusCode)
		}

		// 4. Authorized (jobs:write) -> 200
		reqAuthorized := httptest.NewRequest(http.MethodPost, path, nil)
		reqAuthorized.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
		respAuthorized, err := app.Test(reqAuthorized)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		_ = respAuthorized.Body.Close()
		if respAuthorized.StatusCode != http.StatusOK {
			t.Fatalf("%s jobs:write: expected 200, got %d", path, respAuthorized.StatusCode)
		}
	}
}

func TestQueues_Sanitized500Errors(t *testing.T) {
	t.Parallel()

	repo := &mockQueueRepo{
		pauseFunc: func(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error) {
			return nil, errors.New("FATAL: relation \"queue_states\" does not exist (SQLSTATE 42P01)")
		},
		resumeFunc: func(ctx context.Context, p queuecore.ResumeQueueParams) (*queuecore.QueueState, error) {
			return nil, errors.New("FATAL: connection to server was lost")
		},
	}

	app, _ := setupTestApp(repo, nil)

	for _, path := range []string{"/queues/default/pause", "/queues/default/resume"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)

		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("app.Test failed: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d", resp.StatusCode)
		}

		var res map[string]string
		if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
			t.Fatalf("decode json: %v", err)
		}
		if res["error"] != "internal server error" {
			t.Fatalf("expected sanitized 'internal server error', got %q", res["error"])
		}
	}
}
