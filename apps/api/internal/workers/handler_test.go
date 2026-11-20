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
	queryWorkersFunc     func(ctx context.Context) ([]workerResponse, error)
	getWorkerFunc        func(ctx context.Context, id string) (*workerResponse, error)
	registerWorkerFunc   func(ctx context.Context, p registerWorkerParams) (*workerResponse, error)
	heartbeatWorkerFunc  func(ctx context.Context, id string) (*heartbeatResponse, error)
	claimJobFunc         func(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error)
	renewJobLeaseFunc    func(ctx context.Context, workerID, jobID string) (*queuecore.Job, error)
	completeJobFunc      func(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error)
	failJobFunc          func(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error)
	releaseLeaseFunc     func(ctx context.Context, workerID, jobID string) error
	drainWorkerFunc      func(ctx context.Context, id string) (*workerResponse, error)
	cordonWorkerFunc     func(ctx context.Context, id string) (*workerResponse, error)
	resumeWorkerFunc     func(ctx context.Context, id string) (*workerResponse, error)
	deregisterWorkerFunc func(ctx context.Context, id string) error
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

func (m *mockWorkerStore) RegisterWorker(ctx context.Context, p registerWorkerParams) (*workerResponse, error) {
	if m.registerWorkerFunc != nil {
		return m.registerWorkerFunc(ctx, p)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) HeartbeatWorker(ctx context.Context, id string) (*heartbeatResponse, error) {
	if m.heartbeatWorkerFunc != nil {
		return m.heartbeatWorkerFunc(ctx, id)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) ClaimJob(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error) {
	if m.claimJobFunc != nil {
		return m.claimJobFunc(ctx, id, queues, handlers)
	}
	return nil, nil
}

func (m *mockWorkerStore) RenewJobLease(ctx context.Context, workerID, jobID string) (*queuecore.Job, error) {
	if m.renewJobLeaseFunc != nil {
		return m.renewJobLeaseFunc(ctx, workerID, jobID)
	}
	return nil, queuecore.ErrLeaseLost
}

func (m *mockWorkerStore) CompleteJob(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error) {
	if m.completeJobFunc != nil {
		return m.completeJobFunc(ctx, workerID, jobID, result)
	}
	return nil, queuecore.ErrJobNotFound
}

func (m *mockWorkerStore) FailJob(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error) {
	if m.failJobFunc != nil {
		return m.failJobFunc(ctx, workerID, jobID, jerr, permanent)
	}
	return nil, queuecore.ErrJobNotFound
}

func (m *mockWorkerStore) ReleaseLease(ctx context.Context, workerID, jobID string) error {
	if m.releaseLeaseFunc != nil {
		return m.releaseLeaseFunc(ctx, workerID, jobID)
	}
	return nil
}

func (m *mockWorkerStore) DrainWorker(ctx context.Context, id string) (*workerResponse, error) {
	if m.drainWorkerFunc != nil {
		return m.drainWorkerFunc(ctx, id)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) CordonWorker(ctx context.Context, id string) (*workerResponse, error) {
	if m.cordonWorkerFunc != nil {
		return m.cordonWorkerFunc(ctx, id)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) ResumeWorker(ctx context.Context, id string) (*workerResponse, error) {
	if m.resumeWorkerFunc != nil {
		return m.resumeWorkerFunc(ctx, id)
	}
	return nil, ErrWorkerNotFound
}

func (m *mockWorkerStore) DeregisterWorker(ctx context.Context, id string) error {
	if m.deregisterWorkerFunc != nil {
		return m.deregisterWorkerFunc(ctx, id)
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
		app.Post("/workers/register", h.RegisterWorker)
		app.Get("/workers/:id", h.GetByID)
		app.Post("/workers/:id/heartbeat", h.Heartbeat)
		app.Post("/workers/:id/claim", h.Claim)
		app.Post("/workers/:id/jobs/:jobId/heartbeat", h.RenewJobLease)
		app.Post("/workers/:id/jobs/:jobId/complete", h.CompleteJob)
		app.Post("/workers/:id/jobs/:jobId/fail", h.FailJob)
		app.Post("/workers/:id/leases/:jobId/release", h.ReleaseLease)
		app.Post("/workers/:id/drain", h.Drain)
		app.Post("/workers/:id/cordon", h.Cordon)
		app.Patch("/workers/:id/cordon", h.Cordon)
		app.Post("/workers/:id/resume", h.Resume)
		app.Patch("/workers/:id/resume", h.Resume)
		app.Delete("/workers/:id", h.Deregister)
		app.Post("/workers/:id/deregister", h.Deregister)
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
		drainWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{ID: id, State: "draining"}, nil
		},
		cordonWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{ID: id, State: "cordoned"}, nil
		},
		resumeWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{ID: id, State: "active"}, nil
		},
		deregisterWorkerFunc: func(ctx context.Context, id string) error {
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

	// 4. Lifecycle controls require jobs:write
	endpoints := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/workers/01WORKER1/drain"},
		{http.MethodPost, "/workers/01WORKER1/cordon"},
		{http.MethodPost, "/workers/01WORKER1/resume"},
		{http.MethodDelete, "/workers/01WORKER1"},
	}

	for _, ep := range endpoints {
		// 4a. Insufficient scope -> 403 Forbidden
		reqForbidden := httptest.NewRequest(ep.method, ep.path, nil)
		reqForbidden.Header.Set("X-Test-Scopes", auth.ScopeQueueRead)
		rForbidden, err := app.Test(reqForbidden)
		if err != nil {
			t.Fatal(err)
		}
		_ = rForbidden.Body.Close()
		if rForbidden.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s with queue:read expected 403, got %d", ep.method, ep.path, rForbidden.StatusCode)
		}

		// 4b. Authorized scope -> 200 OK
		reqOK := httptest.NewRequest(ep.method, ep.path, nil)
		reqOK.Header.Set("X-Test-Scopes", auth.ScopeJobsWrite)
		rOK, err := app.Test(reqOK)
		if err != nil {
			t.Fatal(err)
		}
		_ = rOK.Body.Close()
		if rOK.StatusCode != http.StatusOK {
			t.Fatalf("%s %s with jobs:write expected 200, got %d", ep.method, ep.path, rOK.StatusCode)
		}
	}
}

func TestDrain_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		drainWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			if id == "01WORKER1" {
				return &workerResponse{
					ID:    "01WORKER1",
					State: "draining",
				}, nil
			}
			return nil, ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/drain", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res workerResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.State != "draining" {
		t.Fatalf("expected state draining, got %s", res.State)
	}
	if len(broadcaster.dirty) == 0 {
		t.Fatal("expected broadcaster MarkDirty to be called")
	}
}

func TestDrain_Conflict(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		drainWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return nil, ErrWorkerConflict
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/drain", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}
}

func TestCordon_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		cordonWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{
				ID:    id,
				State: "cordoned",
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/cordon", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res workerResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.State != "cordoned" {
		t.Fatalf("expected state cordoned, got %s", res.State)
	}
}

func TestResume_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		resumeWorkerFunc: func(ctx context.Context, id string) (*workerResponse, error) {
			return &workerResponse{
				ID:    id,
				State: "active",
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/resume", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res workerResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.State != "active" {
		t.Fatalf("expected state active, got %s", res.State)
	}
}

func TestDeregister_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		deregisterWorkerFunc: func(ctx context.Context, id string) error {
			if id == "01WORKER1" {
				return nil
			}
			return ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodDelete, "/workers/01WORKER1", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res["deregistered"] != true || res["workerId"] != "01WORKER1" {
		t.Fatalf("unexpected deregister payload: %v", res)
	}
}

func TestDeregister_ConflictWithActiveLeases(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		deregisterWorkerFunc: func(ctx context.Context, id string) error {
			return ErrActiveLeases
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodDelete, "/workers/01WORKER1", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}
}

func TestDeregister_NotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		deregisterWorkerFunc: func(ctx context.Context, id string) error {
			return ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodDelete, "/workers/nonexistent", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}
}

func TestRegisterWorker_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		registerWorkerFunc: func(ctx context.Context, p registerWorkerParams) (*workerResponse, error) {
			return &workerResponse{
				ID:                       p.ID,
				Hostname:                 p.Hostname,
				PID:                      p.PID,
				Version:                  p.Version,
				State:                    "active",
				StartedAt:                now,
				LastHeartbeatAt:          now,
				HeartbeatIntervalSeconds: p.HeartbeatIntervalSeconds,
				Queues:                   p.Queues,
				Handlers:                 p.Handlers,
				MaxConcurrency:           p.MaxConcurrency,
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	body := `{"id":"01EXTWORKER1","hostname":"ext-node-1","queues":["default"],"handlers":["send_email"],"maxConcurrency":5}`
	req := httptest.NewRequest(http.MethodPost, "/workers/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var w workerResponse
	if err := json.NewDecoder(resp.Body).Decode(&w); err != nil {
		t.Fatal(err)
	}
	if w.ID != "01EXTWORKER1" || w.MaxConcurrency != 5 || w.State != "active" {
		t.Fatalf("unexpected worker: %+v", w)
	}
	if len(broadcaster.dirty) == 0 {
		t.Fatal("expected broadcaster dirty event")
	}
}

func TestRegisterWorker_ValidationErrors(t *testing.T) {
	t.Parallel()

	app, _ := setupTestApp(&mockWorkerStore{}, nil, nil)

	cases := []struct {
		name string
		body string
	}{
		{"empty body", `{}`},
		{"missing queues", `{"handlers":["h1"],"maxConcurrency":1}`},
		{"empty queues", `{"queues":[],"handlers":["h1"],"maxConcurrency":1}`},
		{"missing handlers", `{"queues":["q1"],"maxConcurrency":1}`},
		{"empty handlers", `{"queues":["q1"],"handlers":[],"maxConcurrency":1}`},
		{"zero concurrency", `{"queues":["q1"],"handlers":["h1"],"maxConcurrency":0}`},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodPost, "/workers/register", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			resp, err := app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("[%s] expected 400 Bad Request, got %d", tc.name, resp.StatusCode)
			}
		})
	}
}

func TestHeartbeatWorker_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	store := &mockWorkerStore{
		heartbeatWorkerFunc: func(ctx context.Context, id string) (*heartbeatResponse, error) {
			if id == "01WORKER1" {
				return &heartbeatResponse{
					ID:              id,
					State:           "active",
					LastHeartbeatAt: now,
				}, nil
			}
			return nil, ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/heartbeat", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var hb heartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&hb); err != nil {
		t.Fatal(err)
	}
	if hb.ID != "01WORKER1" || hb.State != "active" {
		t.Fatalf("unexpected heartbeat response: %+v", hb)
	}
}

func TestHeartbeatWorker_NotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		heartbeatWorkerFunc: func(ctx context.Context, id string) (*heartbeatResponse, error) {
			return nil, ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/nonexistent/heartbeat", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}
}

func TestClaimJob_Success(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	leaseExp := now.Add(30 * time.Second)
	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		claimJobFunc: func(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:             "01JOB1",
				Queue:          "default",
				Handler:        "send_email",
				Status:         queuecore.StatusRunning,
				Attempt:        1,
				MaxAttempts:    3,
				Priority:       5,
				Payload:        json.RawMessage(`{"to":"test@example.com"}`),
				LeaseExpiresAt: &leaseExp,
				StartedAt:      &now,
				EnqueuedAt:     now,
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/claim", strings.NewReader(`{"queues":["default"]}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var j jobClaimResponse
	if err := json.NewDecoder(resp.Body).Decode(&j); err != nil {
		t.Fatal(err)
	}
	if j.ID != "01JOB1" || j.LeaseExpiresAt == nil {
		t.Fatalf("unexpected claim response: %+v", j)
	}
	if len(broadcaster.dirty) == 0 {
		t.Fatal("expected broadcaster dirty event")
	}
}

func TestClaimJob_NoContent(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		claimJobFunc: func(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error) {
			return nil, nil // No runnable jobs
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/claim", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d", resp.StatusCode)
	}
}

func TestClaimJob_WorkerNotFound(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		claimJobFunc: func(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error) {
			return nil, ErrWorkerNotFound
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/nonexistent/claim", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}
}

func TestRenewJobLease_Success(t *testing.T) {
	t.Parallel()

	leaseExp := time.Now().UTC().Add(30 * time.Second)
	store := &mockWorkerStore{
		renewJobLeaseFunc: func(ctx context.Context, workerID, jobID string) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:             jobID,
				LeaseExpiresAt: &leaseExp,
			}, nil
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/heartbeat", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res["renewed"] != true || res["jobId"] != "01JOB1" {
		t.Fatalf("unexpected renewal response: %+v", res)
	}
}

func TestRenewJobLease_Conflict(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		renewJobLeaseFunc: func(ctx context.Context, workerID, jobID string) (*queuecore.Job, error) {
			return nil, queuecore.ErrLeaseLost
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/heartbeat", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}
}

func TestCompleteJob_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		completeJobFunc: func(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:     jobID,
				Status: queuecore.StatusSucceeded,
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/complete", strings.NewReader(`{"result":{"status":"ok"}}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res["completed"] != true || res["status"] != "succeeded" {
		t.Fatalf("unexpected complete response: %+v", res)
	}
	if len(broadcaster.dirty) == 0 {
		t.Fatal("expected broadcaster dirty event")
	}
}

func TestCompleteJob_Conflict(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		completeJobFunc: func(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error) {
			return nil, queuecore.ErrLeaseExpired
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/complete", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}
}

func TestFailJob_Success(t *testing.T) {
	t.Parallel()

	broadcaster := &mockBroadcaster{}
	store := &mockWorkerStore{
		failJobFunc: func(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:     jobID,
				Status: queuecore.StatusFailed,
			}, nil
		},
	}
	app, _ := setupTestApp(store, broadcaster, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/fail", strings.NewReader(`{"errorClass":"NetworkErr","message":"timeout","permanent":false}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res["failed"] != true || res["status"] != "failed" || res["permanent"] != false {
		t.Fatalf("unexpected fail response: %+v", res)
	}
	if len(broadcaster.dirty) == 0 {
		t.Fatal("expected broadcaster dirty event")
	}
}

func TestFailJob_PermanentDeadLetter(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		failJobFunc: func(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error) {
			return &queuecore.Job{
				ID:     jobID,
				Status: queuecore.StatusDeadLettered,
			}, nil
		},
	}
	app, _ := setupTestApp(store, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/workers/01WORKER1/jobs/01JOB1/fail", strings.NewReader(`{"error":{"class":"InvalidData","message":"bad format"},"permanent":true}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res["failed"] != true || res["status"] != "dead_lettered" || res["permanent"] != true || res["terminal"] != true {
		t.Fatalf("unexpected fail response: %+v", res)
	}
}

func TestWorkerRoutes_AuthScopeEnforcement(t *testing.T) {
	t.Parallel()

	store := &mockWorkerStore{
		registerWorkerFunc: func(ctx context.Context, p registerWorkerParams) (*workerResponse, error) {
			return &workerResponse{ID: "w1"}, nil
		},
	}
	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	app, _ := setupTestApp(store, nil, authn)

	// Subtest 1: Unauthenticated -> 401
	req1 := httptest.NewRequest(http.MethodPost, "/workers/register", strings.NewReader(`{"queues":["q"],"handlers":["h"],"maxConcurrency":1}`))
	req1.Header.Set("Content-Type", "application/json")
	resp1, err := app.Test(req1)
	if err != nil {
		t.Fatal(err)
	}
	if resp1.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized, got %d", resp1.StatusCode)
	}
}
