package workers

import (
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

type mockWorkerStore struct {
	queryWorkersFunc func(ctx context.Context) ([]workerResponse, error)
	getWorkerFunc    func(ctx context.Context, id string) (*workerResponse, error)
	releaseLeaseFunc func(ctx context.Context, workerID, jobID string) error
}

func (m *mockWorkerStore) QueryWorkers(ctx context.Context) ([]workerResponse, error) {
	if m.queryWorkersFunc != nil {
		return m.queryWorkersFunc(ctx)
	}
	return []workerResponse{}, nil
}

func (m *mockWorkerStore) GetWorker(ctx context.Context, id string) (*workerResponse, error) {
	if m.getWorkerFunc != nil {
		return m.getWorkerFunc(ctx, id)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) ReleaseLease(ctx context.Context, workerID, jobID string) error {
	if m.releaseLeaseFunc != nil {
		return m.releaseLeaseFunc(ctx, workerID, jobID)
	}
	return nil
}

type mockBroadcaster struct {
	dirty []string
}

func (m *mockBroadcaster) MarkDirty(resources ...string) {
	m.dirty = append(m.dirty, resources...)
}

func setupTestApp(store workerStore, broadcaster eventBroadcaster, authn *auth.Authenticator) (*fiber.App, *Handler) {
	h := newHandlerWithStore(store, broadcaster)
	app := fiber.New()
	if authn != nil {
		Register(app, h, authn)
	} else {
		app.Get("/workers", h.List)
		app.Get("/workers/:id", h.GetByID)
		app.Post("/workers/:id/leases/:jobId/release", h.ReleaseLease)
	}
	return app, h
}

func TestGetByID_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	store := &mockWorkerStore{
		getWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			if id == "01WORKER1" {
				return &workerResponse{
					ID:                       "01WORKER1",
					Hostname:                 "worker-node-1",
					PID:                      1234,
					Version:                  "1.0.0",
					State:                    "active",
					StartedAt:                now,
					LastHeartbeatAt:          now,
					HeartbeatIntervalSeconds: 5,
					Queues:                   []string{"default"},
					Handlers:                 []string{"http_request"},
					MaxConcurrency:           10,
					InFlight:                 1,
					TotalProcessed:           42,
					Leases: []leaseResponse{
						{
							JobID:          "01JOB1",
							Handler:        "http_request",
							Queue:          "default",
							Attempt:        1,
							LeasedAt:       now.Format(time.RFC3339Nano),
							LeaseExpiresAt: now.Add(30 * time.Second).Format(time.RFC3339Nano),
						},
					},
				}, nil
			}
			return nil, ErrWorkerNotFound
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/workers/01WORKER1", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}

	var w workerResponse
	if err := json.Unmarshal(body, &w); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if w.ID != "01WORKER1" || w.Hostname != "worker-node-1" {
		t.Fatalf("unexpected worker response: %+v", w)
	}
	if w.InFlight != 1 || len(w.Leases) != 1 || w.Leases[0].JobID != "01JOB1" {
		t.Fatalf("unexpected lease data: %+v", w)
	}
}

func TestGetByID_NotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		getWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return nil, ErrWorkerNotFound
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/workers/01NONEXISTENT", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "worker not found" {
		t.Fatalf("expected 'worker not found', got %q", errResp["error"])
	}
}

func TestGetByID_InternalErrorSanitized(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		getWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return nil, errors.New("db connection pool exhausted")
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/workers/01WORKER1", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "internal server error" {
		t.Fatalf("expected sanitized 'internal server error', got %q", errResp["error"])
	}
}

func TestReleaseLease_Success(t *testing.T) {
	t.Parallel()

	var releasedWorker, releasedJob string
	broadcaster := &mockBroadcaster{}

	store := &mockWorkerStore{
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			releasedWorker = workerID
			releasedJob = jobID
			return nil
		},
	}

	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB1/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	if releasedWorker != "01WORKER1" || releasedJob != "01JOB1" {
		t.Fatalf("unexpected release parameters: worker=%s job=%s", releasedWorker, releasedJob)
	}

	body, _ := io.ReadAll(resp.Body)
	var res map[string]any
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}

	if res["released"] != true || res["workerId"] != "01WORKER1" || res["jobId"] != "01JOB1" {
		t.Fatalf("unexpected JSON body: %+v", res)
	}

	// Verify SSE invalidation was triggered for workers, jobs, and stats
	expectedResources := map[string]bool{"workers": false, "jobs": false, "stats": false}
	for _, res := range broadcaster.dirty {
		if _, ok := expectedResources[res]; ok {
			expectedResources[res] = true
		}
	}
	for res, seen := range expectedResources {
		if !seen {
			t.Fatalf("expected resource %q to be marked dirty, got: %v", res, broadcaster.dirty)
		}
	}
}

func TestReleaseLease_WorkerNotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			return ErrWorkerNotFound
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01NONEXISTENT/leases/01JOB1/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "worker not found" {
		t.Fatalf("expected 'worker not found', got %q", errResp["error"])
	}
}

func TestReleaseLease_JobNotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			return queuecore.ErrJobNotFound
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01NONEXISTENT/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "job not found" {
		t.Fatalf("expected 'job not found', got %q", errResp["error"])
	}
}

func TestReleaseLease_LeaseConflict(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			return queuecore.ErrLeaseConflict
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB_HELD_BY_OTHER/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "job is not running or leased by this worker" {
		t.Fatalf("expected conflict error, got %q", errResp["error"])
	}
}

func TestReleaseLease_InternalErrorSanitized(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			return errors.New("deadlock detected")
		},
	}

	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB1/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var errResp map[string]string
	_ = json.Unmarshal(body, &errResp)
	if errResp["error"] != "internal server error" {
		t.Fatalf("expected 'internal server error', got %q", errResp["error"])
	}
}

func TestGetByID_BadRequest(t *testing.T) {
	t.Parallel()

	app, _ := setupTestApp(&mockWorkerStore{}, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/workers/%20", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", resp.StatusCode)
	}
}

func TestReleaseLease_BadRequest(t *testing.T) {
	t.Parallel()

	app, _ := setupTestApp(&mockWorkerStore{}, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/%20/leases/01JOB1/release", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", resp.StatusCode)
	}
}

func TestWorkers_AuthScopesEnforced(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		getWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{ID: id}, nil
		},
		releaseLeaseFunc: func(ctx context.Context, workerID, jobID string) error {
			return nil
		},
	}

	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	h := newHandlerWithStore(store, nil)
	app := fiber.New()

	// Inject test principal from header when provided
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

	// 1. Unauthenticated requests should be 401
	for _, path := range []string{"/workers", "/workers/01WORKER1"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated: expected 401, got %d", path, resp.StatusCode)
		}
	}

	releaseReq := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB1/release", nil)
	releaseResp, err := app.Test(releaseReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = releaseResp.Body.Close()
	if releaseResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("release unauthenticated: expected 401, got %d", releaseResp.StatusCode)
	}

	// 2. Insufficient scope requests should be 403 Forbidden
	// GET /workers/:id requires queue:read -> should fail with jobs:write
	getWithJobsWrite := httptest.NewRequest(http.MethodGet, "/workers/01WORKER1", nil)
	getWithJobsWrite.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
	resp, err := app.Test(getWithJobsWrite)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET with jobs:write expected 403, got %d", resp.StatusCode)
	}

	// POST /workers/:id/leases/:jobId/release requires jobs:write -> should fail with queue:read
	releaseWithQueueRead := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB1/release", nil)
	releaseWithQueueRead.Header.Set("X-Test-Scopes", auth.ScopeQueueRead)
	resp, err = app.Test(releaseWithQueueRead)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST release with queue:read expected 403, got %d", resp.StatusCode)
	}

	// 3. Authorized scope requests should be 200 OK
	getWithQueueRead := httptest.NewRequest(http.MethodGet, "/workers/01WORKER1", nil)
	getWithQueueRead.Header.Set("X-Test-Scopes", auth.ScopeQueueRead)
	resp, err = app.Test(getWithQueueRead)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET with queue:read expected 200, got %d", resp.StatusCode)
	}

	releaseWithJobsWrite := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/leases/01JOB1/release", nil)
	releaseWithJobsWrite.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
	resp, err = app.Test(releaseWithJobsWrite)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST release with jobs:write expected 200, got %d", resp.StatusCode)
	}
}
