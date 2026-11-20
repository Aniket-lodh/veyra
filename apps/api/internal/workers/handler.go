// Package workers is the HTTP layer and sweeper for the workers table.
package workers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oklog/ulid/v2"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// ErrWorkerNotFound is returned when no worker with the given ID exists.
var ErrWorkerNotFound = errors.New("worker not found")

// ErrWorkerConflict is returned when an invalid state transition is attempted (e.g. on a disconnected worker).
var ErrWorkerConflict = errors.New("worker conflict")

// ErrActiveLeases is returned when attempting to deregister a worker with active leases.
var ErrActiveLeases = errors.New("cannot deregister worker with active leases")

type eventBroadcaster interface {
	MarkDirty(resources ...string)
}

type workerStore interface {
	QueryWorkers(ctx context.Context) ([]workerResponse, error)
	GetWorker(ctx context.Context, id string) (*workerResponse, error)
	RegisterWorker(ctx context.Context, p registerWorkerParams) (*workerResponse, error)
	HeartbeatWorker(ctx context.Context, id string) (*heartbeatResponse, error)
	ClaimJob(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error)
	RenewJobLease(ctx context.Context, workerID, jobID string) (*queuecore.Job, error)
	CompleteJob(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error)
	FailJob(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error)
	ReleaseLease(ctx context.Context, workerID, jobID string) error
	DrainWorker(ctx context.Context, id string) (*workerResponse, error)
	CordonWorker(ctx context.Context, id string) (*workerResponse, error)
	ResumeWorker(ctx context.Context, id string) (*workerResponse, error)
	DeregisterWorker(ctx context.Context, id string) error
}

// Handler is the apps/api binding for workers-table reads and lease operations.
type Handler struct {
	store       workerStore
	broadcaster eventBroadcaster
}

func NewHandler(pool *pgxpool.Pool, repo *queuecore.Repository, broadcaster ...eventBroadcaster) *Handler {
	var b eventBroadcaster
	if len(broadcaster) > 0 {
		b = broadcaster[0]
	}
	var store workerStore
	if pool != nil && repo != nil {
		store = newPGWorkerStore(pool, repo)
	}
	return &Handler{
		store:       store,
		broadcaster: b,
	}
}

// newHandlerWithStore creates a Handler with an injected store (for testing).
func newHandlerWithStore(store workerStore, broadcaster eventBroadcaster) *Handler {
	return &Handler{
		store:       store,
		broadcaster: broadcaster,
	}
}

// Register mounts worker read and lifecycle endpoints.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Get("/workers", authn.Require(auth.ScopeQueueRead), h.List)
	app.Post("/workers/register", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.RegisterWorker)
	app.Get("/workers/:id", authn.Require(auth.ScopeQueueRead), h.GetByID)
	app.Post("/workers/:id/heartbeat", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Heartbeat)
	app.Post("/workers/:id/claim", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Claim)
	app.Post("/workers/:id/jobs/:jobId/heartbeat", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.RenewJobLease)
	app.Post("/workers/:id/jobs/:jobId/complete", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.CompleteJob)
	app.Post("/workers/:id/jobs/:jobId/fail", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.FailJob)
	app.Post("/workers/:id/leases/:jobId/release", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.ReleaseLease)
	app.Post("/workers/:id/drain", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Drain)
	app.Post("/workers/:id/cordon", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Cordon)
	app.Patch("/workers/:id/cordon", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Cordon)
	app.Post("/workers/:id/resume", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Resume)
	app.Patch("/workers/:id/resume", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Resume)
	app.Delete("/workers/:id", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Deregister)
	app.Post("/workers/:id/deregister", authn.RequireAny(auth.ScopeWorkersWrite, auth.ScopeJobsWrite), h.Deregister)
}

// leaseResponse mirrors the frontend WorkerLease interface.
type leaseResponse struct {
	JobID          string `json:"jobId"`
	Handler        string `json:"handler"`
	Queue          string `json:"queue"`
	Attempt        int    `json:"attempt"`
	LeasedAt       string `json:"leasedAt"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

// workerResponse mirrors the frontend Worker interface.
type workerResponse struct {
	ID                       string          `json:"id"`
	Hostname                 string          `json:"hostname"`
	PID                      int             `json:"pid"`
	Version                  string          `json:"version"`
	State                    string          `json:"state"`
	StartedAt                time.Time       `json:"startedAt"`
	LastHeartbeatAt          time.Time       `json:"lastHeartbeatAt"`
	HeartbeatIntervalSeconds int             `json:"heartbeatIntervalSeconds"`
	Queues                   []string        `json:"queues"`
	Handlers                 []string        `json:"handlers"`
	MaxConcurrency           int             `json:"maxConcurrency"`
	InFlight                 int             `json:"inFlight"`
	TotalProcessed           int64           `json:"totalProcessed"`
	Leases                   []leaseResponse `json:"leases"`
}

type registerWorkerParams struct {
	ID                       string
	Hostname                 string
	PID                      int
	Version                  string
	Queues                   []string
	Handlers                 []string
	MaxConcurrency           int
	HeartbeatIntervalSeconds int
}

type registerWorkerRequest struct {
	ID                       string   `json:"id"`
	Hostname                 string   `json:"hostname"`
	PID                      int      `json:"pid"`
	Version                  string   `json:"version"`
	Queues                   []string `json:"queues"`
	Handlers                 []string `json:"handlers"`
	MaxConcurrency           int      `json:"maxConcurrency"`
	HeartbeatIntervalSeconds int      `json:"heartbeatIntervalSeconds"`
}

type heartbeatResponse struct {
	ID              string    `json:"id"`
	State           string    `json:"state"`
	LastHeartbeatAt time.Time `json:"lastHeartbeatAt"`
}

type claimRequest struct {
	Queues   []string `json:"queues"`
	Handlers []string `json:"handlers"`
}

type jobClaimResponse struct {
	ID             string          `json:"id"`
	Queue          string          `json:"queue"`
	Handler        string          `json:"handler"`
	Status         string          `json:"status"`
	Attempt        int             `json:"attempt"`
	MaxAttempts    int             `json:"maxAttempts"`
	Priority       int             `json:"priority"`
	Payload        json.RawMessage `json:"payload"`
	LeaseExpiresAt *time.Time      `json:"leaseExpiresAt"`
	StartedAt      *time.Time      `json:"startedAt"`
	EnqueuedAt     time.Time       `json:"enqueuedAt"`
}

func toJobClaimResponse(j *queuecore.Job) jobClaimResponse {
	return jobClaimResponse{
		ID:             j.ID,
		Queue:          j.Queue,
		Handler:        j.Handler,
		Status:         string(j.Status),
		Attempt:        j.Attempt,
		MaxAttempts:    j.MaxAttempts,
		Priority:       j.Priority,
		Payload:        j.Payload,
		LeaseExpiresAt: j.LeaseExpiresAt,
		StartedAt:      j.StartedAt,
		EnqueuedAt:     j.EnqueuedAt,
	}
}

type completeJobRequest struct {
	Result json.RawMessage `json:"result,omitempty"`
}

type failJobRequest struct {
	ErrorClass string `json:"errorClass"`
	Message    string `json:"message"`
	StackTrace string `json:"stackTrace"`
	Permanent  bool   `json:"permanent"`
	Error      *struct {
		Class      string `json:"class"`
		Message    string `json:"message"`
		StackTrace string `json:"stackTrace"`
	} `json:"error"`
}

// RegisterWorker handles POST /workers/register.
func (h *Handler) RegisterWorker(c fiber.Ctx) error {
	var req registerWorkerRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}

	req.Hostname = strings.TrimSpace(req.Hostname)
	if req.Hostname == "" {
		req.Hostname = "external"
	}
	req.Version = strings.TrimSpace(req.Version)
	if req.Version == "" {
		req.Version = "1.0.0"
	}
	if req.HeartbeatIntervalSeconds <= 0 {
		req.HeartbeatIntervalSeconds = 10
	}
	if req.MaxConcurrency < 1 {
		return badRequest(c, "maxConcurrency must be at least 1")
	}
	if len(req.Queues) == 0 {
		return badRequest(c, "queues must be a non-empty array")
	}
	if len(req.Handlers) == 0 {
		return badRequest(c, "handlers must be a non-empty array")
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		req.ID = ulid.Make().String()
	}

	ctx := c.Context()
	worker, err := h.store.RegisterWorker(ctx, registerWorkerParams(req))
	if err != nil {
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.registered",
		"event", "workers.registered",
		"workerId", worker.ID,
		"hostname", worker.Hostname,
		"queues", worker.Queues,
		"handlers", worker.Handlers,
		"maxConcurrency", worker.MaxConcurrency,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "stats")
	}

	return c.JSON(worker)
}

// Heartbeat handles POST /workers/:id/heartbeat.
func (h *Handler) Heartbeat(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	hb, err := h.store.HeartbeatWorker(ctx, id)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		return internalError(c, err)
	}

	return c.JSON(hb)
}

// Claim handles POST /workers/:id/claim.
func (h *Handler) Claim(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	var req claimRequest
	if len(c.Body()) > 0 {
		if err := json.Unmarshal(c.Body(), &req); err != nil {
			return badRequest(c, "invalid JSON body: "+err.Error())
		}
	}

	ctx := c.Context()
	job, err := h.store.ClaimJob(ctx, id, req.Queues, req.Handlers)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if strings.Contains(err.Error(), "no queues or handlers") {
			return badRequest(c, err.Error())
		}
		return internalError(c, err)
	}

	if job == nil {
		return c.Status(fiber.StatusNoContent).Send(nil)
	}

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "jobs", "stats")
	}

	return c.JSON(toJobClaimResponse(job))
}

// RenewJobLease handles POST /workers/:id/jobs/:jobId/heartbeat.
func (h *Handler) RenewJobLease(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	rawJobID := c.Params("jobId")
	jobID, err := url.PathUnescape(rawJobID)
	if err != nil {
		jobID = rawJobID
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return badRequest(c, "job id is required")
	}

	ctx := c.Context()
	job, err := h.store.RenewJobLease(ctx, id, jobID)
	if err != nil {
		if errors.Is(err, queuecore.ErrLeaseLost) || errors.Is(err, queuecore.ErrLeaseExpired) || errors.Is(err, queuecore.ErrJobNotFound) || errors.Is(err, queuecore.ErrLeaseConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "lease lost or expired",
			})
		}
		return internalError(c, err)
	}

	return c.JSON(fiber.Map{
		"renewed":        true,
		"jobId":          job.ID,
		"workerId":       id,
		"leaseExpiresAt": job.LeaseExpiresAt,
	})
}

// CompleteJob handles POST /workers/:id/jobs/:jobId/complete.
func (h *Handler) CompleteJob(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	rawJobID := c.Params("jobId")
	jobID, err := url.PathUnescape(rawJobID)
	if err != nil {
		jobID = rawJobID
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return badRequest(c, "job id is required")
	}

	var req completeJobRequest
	if len(c.Body()) > 0 {
		if err := json.Unmarshal(c.Body(), &req); err != nil {
			return badRequest(c, "invalid JSON body: "+err.Error())
		}
	}

	ctx := c.Context()
	job, err := h.store.CompleteJob(ctx, id, jobID, req.Result)
	if err != nil {
		if errors.Is(err, queuecore.ErrJobNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
		}
		if errors.Is(err, queuecore.ErrLeaseLost) || errors.Is(err, queuecore.ErrLeaseExpired) || errors.Is(err, queuecore.ErrLeaseConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "lease lost or expired",
			})
		}
		return internalError(c, err)
	}

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "jobs", "stats")
	}

	return c.JSON(fiber.Map{
		"completed": true,
		"jobId":     job.ID,
		"workerId":  id,
		"status":    string(job.Status),
	})
}

// FailJob handles POST /workers/:id/jobs/:jobId/fail.
func (h *Handler) FailJob(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	rawJobID := c.Params("jobId")
	jobID, err := url.PathUnescape(rawJobID)
	if err != nil {
		jobID = rawJobID
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return badRequest(c, "job id is required")
	}

	var req failJobRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}

	if req.Error != nil {
		if req.ErrorClass == "" {
			req.ErrorClass = req.Error.Class
		}
		if req.Message == "" {
			req.Message = req.Error.Message
		}
		if req.StackTrace == "" {
			req.StackTrace = req.Error.StackTrace
		}
	}
	if req.ErrorClass == "" {
		req.ErrorClass = "HandlerError"
	}
	if strings.TrimSpace(req.Message) == "" {
		return badRequest(c, "error message is required")
	}

	ctx := c.Context()
	job, err := h.store.FailJob(ctx, id, jobID, queuecore.JobError{
		Class:      req.ErrorClass,
		Message:    req.Message,
		StackTrace: req.StackTrace,
		OccurredAt: time.Now().UTC(),
	}, req.Permanent)
	if err != nil {
		if errors.Is(err, queuecore.ErrJobNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
		}
		if errors.Is(err, queuecore.ErrLeaseLost) || errors.Is(err, queuecore.ErrLeaseExpired) || errors.Is(err, queuecore.ErrLeaseConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "lease lost or expired",
			})
		}
		return internalError(c, err)
	}

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "jobs", "stats")
	}

	return c.JSON(fiber.Map{
		"failed":    true,
		"jobId":     job.ID,
		"workerId":  id,
		"status":    string(job.Status),
		"permanent": req.Permanent,
		"terminal":  job.Status == queuecore.StatusDeadLettered,
	})
}

// List handles GET /workers.
func (h *Handler) List(c fiber.Ctx) error {
	ctx := c.Context()
	out, err := h.store.QueryWorkers(ctx)
	if err != nil {
		return internalError(c, err)
	}
	return c.JSON(fiber.Map{"workers": out})
}

// GetByID handles GET /workers/:id.
func (h *Handler) GetByID(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	worker, err := h.store.GetWorker(ctx, id)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		return internalError(c, err)
	}

	return c.JSON(worker)
}

// ReleaseLease handles POST /workers/:id/leases/:jobId/release.
func (h *Handler) ReleaseLease(c fiber.Ctx) error {
	workerID, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	rawJobID := c.Params("jobId")
	jobID, err := url.PathUnescape(rawJobID)
	if err != nil {
		jobID = rawJobID
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return badRequest(c, "job id is required")
	}

	ctx := c.Context()
	if err := h.store.ReleaseLease(ctx, workerID, jobID); err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if errors.Is(err, queuecore.ErrJobNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
		}
		if errors.Is(err, queuecore.ErrLeaseConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "job is not running or leased by this worker",
			})
		}
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.lease.released",
		"event", "workers.lease.released",
		"workerId", workerID,
		"jobId", jobID,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "jobs", "stats")
	}

	return c.JSON(fiber.Map{
		"released": true,
		"workerId": workerID,
		"jobId":    jobID,
	})
}

// Drain handles POST /workers/:id/drain.
func (h *Handler) Drain(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	worker, err := h.store.DrainWorker(ctx, id)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if errors.Is(err, ErrWorkerConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.drain",
		"event", "workers.drain",
		"workerId", id,
		"state", worker.State,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "stats")
	}

	return c.JSON(worker)
}

// Cordon handles POST & PATCH /workers/:id/cordon.
func (h *Handler) Cordon(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	worker, err := h.store.CordonWorker(ctx, id)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if errors.Is(err, ErrWorkerConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.cordon",
		"event", "workers.cordon",
		"workerId", id,
		"state", worker.State,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "stats")
	}

	return c.JSON(worker)
}

// Resume handles POST & PATCH /workers/:id/resume.
func (h *Handler) Resume(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	worker, err := h.store.ResumeWorker(ctx, id)
	if err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if errors.Is(err, ErrWorkerConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.resume",
		"event", "workers.resume",
		"workerId", id,
		"state", worker.State,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "stats")
	}

	return c.JSON(worker)
}

// Deregister handles DELETE /workers/:id and POST /workers/:id/deregister.
func (h *Handler) Deregister(c fiber.Ctx) error {
	id, err := parseWorkerID(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	ctx := c.Context()
	if err := h.store.DeregisterWorker(ctx, id); err != nil {
		if errors.Is(err, ErrWorkerNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "worker not found"})
		}
		if errors.Is(err, ErrActiveLeases) || errors.Is(err, ErrWorkerConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		return internalError(c, err)
	}

	slog.InfoContext(ctx, "workers.deregister",
		"event", "workers.deregister",
		"workerId", id,
	)

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty("workers", "stats")
	}

	return c.JSON(fiber.Map{
		"deregistered": true,
		"workerId":     id,
	})
}

func parseWorkerID(c fiber.Ctx) (string, error) {
	rawID := c.Params("id")
	id, err := url.PathUnescape(rawID)
	if err != nil {
		id = rawID
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("worker id is required")
	}
	return id, nil
}

// pgWorkerStore implements workerStore backed by Postgres pool and queuecore.Repository.
type pgWorkerStore struct {
	pool *pgxpool.Pool
	repo *queuecore.Repository
}

func newPGWorkerStore(pool *pgxpool.Pool, repo *queuecore.Repository) *pgWorkerStore {
	return &pgWorkerStore{pool: pool, repo: repo}
}

func (s *pgWorkerStore) QueryWorkers(ctx context.Context) ([]workerResponse, error) {
	const query = `
		SELECT id, hostname, pid, version, state::text,
		       started_at, last_heartbeat_at, heartbeat_interval_seconds,
		       queues, handlers, max_concurrency, total_processed
		FROM workers
		ORDER BY started_at DESC, id ASC
	`
	rs, err := s.pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("workers.queryWorkers: query: %w", err)
	}
	defer rs.Close()

	rows := make([]workerResponse, 0)
	for rs.Next() {
		var w workerResponse
		if err := rs.Scan(
			&w.ID, &w.Hostname, &w.PID, &w.Version, &w.State,
			&w.StartedAt, &w.LastHeartbeatAt, &w.HeartbeatIntervalSeconds,
			&w.Queues, &w.Handlers, &w.MaxConcurrency, &w.TotalProcessed,
		); err != nil {
			return nil, fmt.Errorf("workers.queryWorkers: scan: %w", err)
		}
		w.Leases = []leaseResponse{}
		rows = append(rows, w)
	}
	if err := rs.Err(); err != nil {
		return nil, fmt.Errorf("workers.queryWorkers: rows: %w", err)
	}

	workerIDs := make([]string, 0, len(rows))
	for _, w := range rows {
		workerIDs = append(workerIDs, w.ID)
	}
	leasesByWorker := make(map[string][]leaseResponse, len(workerIDs))
	if len(workerIDs) > 0 {
		leases, err := s.repo.ListRunningLeases(ctx, workerIDs)
		if err != nil {
			return nil, fmt.Errorf("workers.queryWorkers: list leases: %w", err)
		}
		for _, l := range leases {
			lr := leaseResponse{
				JobID:   l.JobID,
				Handler: l.Handler,
				Queue:   l.Queue,
				Attempt: l.Attempt,
			}
			if l.StartedAt != nil {
				lr.LeasedAt = l.StartedAt.Format(time.RFC3339Nano)
			}
			if l.LeaseExpiresAt != nil {
				lr.LeaseExpiresAt = l.LeaseExpiresAt.Format(time.RFC3339Nano)
			}
			leasesByWorker[l.WorkerID] = append(leasesByWorker[l.WorkerID], lr)
		}
	}

	out := make([]workerResponse, 0, len(rows))
	for _, w := range rows {
		leases := leasesByWorker[w.ID]
		if leases == nil {
			leases = []leaseResponse{}
		}
		w.Leases = leases
		w.InFlight = len(leases)
		out = append(out, w)
	}
	return out, nil
}

func (s *pgWorkerStore) GetWorker(ctx context.Context, id string) (*workerResponse, error) {
	const query = `
		SELECT id, hostname, pid, version, state::text,
		       started_at, last_heartbeat_at, heartbeat_interval_seconds,
		       queues, handlers, max_concurrency, total_processed
		FROM workers
		WHERE id = $1
	`
	var w workerResponse
	err := s.pool.QueryRow(ctx, query, id).Scan(
		&w.ID, &w.Hostname, &w.PID, &w.Version, &w.State,
		&w.StartedAt, &w.LastHeartbeatAt, &w.HeartbeatIntervalSeconds,
		&w.Queues, &w.Handlers, &w.MaxConcurrency, &w.TotalProcessed,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.GetWorker: query: %w", err)
	}
	w.Leases = []leaseResponse{}

	leases, err := s.repo.ListRunningLeases(ctx, []string{id})
	if err != nil {
		return nil, fmt.Errorf("workers.GetWorker: list leases: %w", err)
	}
	for _, l := range leases {
		lr := leaseResponse{
			JobID:   l.JobID,
			Handler: l.Handler,
			Queue:   l.Queue,
			Attempt: l.Attempt,
		}
		if l.StartedAt != nil {
			lr.LeasedAt = l.StartedAt.Format(time.RFC3339Nano)
		}
		if l.LeaseExpiresAt != nil {
			lr.LeaseExpiresAt = l.LeaseExpiresAt.Format(time.RFC3339Nano)
		}
		w.Leases = append(w.Leases, lr)
	}
	w.InFlight = len(w.Leases)
	return &w, nil
}

func (s *pgWorkerStore) ReleaseLease(ctx context.Context, workerID, jobID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("workers.ReleaseLease: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists int
	err = tx.QueryRow(ctx, "SELECT 1 FROM workers WHERE id = $1", workerID).Scan(&exists)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWorkerNotFound
		}
		return fmt.Errorf("workers.ReleaseLease: check worker: %w", err)
	}

	if err := s.repo.ForceReleaseLeaseTx(ctx, tx, queuecore.ForceReleaseLeaseParams{
		WorkerID: workerID,
		JobID:    jobID,
	}); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("workers.ReleaseLease: commit tx: %w", err)
	}
	return nil
}

func (s *pgWorkerStore) DrainWorker(ctx context.Context, id string) (*workerResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("workers.DrainWorker: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var state string
	err = tx.QueryRow(ctx, "SELECT state::text FROM workers WHERE id = $1 FOR UPDATE", id).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.DrainWorker: select: %w", err)
	}

	if state == "disconnected" {
		return nil, fmt.Errorf("%w: cannot drain disconnected worker", ErrWorkerConflict)
	}

	if state != "draining" {
		if _, err := tx.Exec(ctx, "UPDATE workers SET state = 'draining' WHERE id = $1", id); err != nil {
			return nil, fmt.Errorf("workers.DrainWorker: update: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workers.DrainWorker: commit: %w", err)
	}

	return s.GetWorker(ctx, id)
}

func (s *pgWorkerStore) CordonWorker(ctx context.Context, id string) (*workerResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("workers.CordonWorker: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var state string
	err = tx.QueryRow(ctx, "SELECT state::text FROM workers WHERE id = $1 FOR UPDATE", id).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.CordonWorker: select: %w", err)
	}

	if state == "disconnected" {
		return nil, fmt.Errorf("%w: cannot cordon disconnected worker", ErrWorkerConflict)
	}

	if state != "cordoned" {
		if _, err := tx.Exec(ctx, "UPDATE workers SET state = 'cordoned' WHERE id = $1", id); err != nil {
			return nil, fmt.Errorf("workers.CordonWorker: update: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workers.CordonWorker: commit: %w", err)
	}

	return s.GetWorker(ctx, id)
}

func (s *pgWorkerStore) ResumeWorker(ctx context.Context, id string) (*workerResponse, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("workers.ResumeWorker: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var state string
	err = tx.QueryRow(ctx, "SELECT state::text FROM workers WHERE id = $1 FOR UPDATE", id).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.ResumeWorker: select: %w", err)
	}

	if state == "disconnected" {
		return nil, fmt.Errorf("%w: cannot resume disconnected worker", ErrWorkerConflict)
	}

	if state == "cordoned" || state == "draining" {
		if _, err := tx.Exec(ctx, "UPDATE workers SET state = 'active' WHERE id = $1", id); err != nil {
			return nil, fmt.Errorf("workers.ResumeWorker: update: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workers.ResumeWorker: commit: %w", err)
	}

	return s.GetWorker(ctx, id)
}

func (s *pgWorkerStore) DeregisterWorker(ctx context.Context, id string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("workers.DeregisterWorker: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists int
	err = tx.QueryRow(ctx, "SELECT 1 FROM workers WHERE id = $1 FOR UPDATE", id).Scan(&exists)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWorkerNotFound
		}
		return fmt.Errorf("workers.DeregisterWorker: select worker: %w", err)
	}

	var activeLeases int
	err = tx.QueryRow(ctx, `
		SELECT count(*) FROM jobs
		WHERE current_worker_id = $1
		  AND status = 'running'
	`, id).Scan(&activeLeases)
	if err != nil {
		return fmt.Errorf("workers.DeregisterWorker: check active leases: %w", err)
	}

	if activeLeases > 0 {
		return fmt.Errorf("%w: cannot deregister worker with %d active lease(s)", ErrActiveLeases, activeLeases)
	}

	if _, err := tx.Exec(ctx, "DELETE FROM workers WHERE id = $1", id); err != nil {
		return fmt.Errorf("workers.DeregisterWorker: delete: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("workers.DeregisterWorker: commit: %w", err)
	}

	return nil
}

func (s *pgWorkerStore) RegisterWorker(ctx context.Context, p registerWorkerParams) (*workerResponse, error) {
	const insertSQL = `
		INSERT INTO workers (
			id, hostname, pid, version, state,
			started_at, last_heartbeat_at, heartbeat_interval_seconds,
			queues, handlers, max_concurrency, total_processed
		) VALUES (
			$1, $2, $3, $4, 'active',
			now(), now(), $5,
			$6, $7, $8, 0
		)
		ON CONFLICT (id) DO UPDATE SET
			hostname = EXCLUDED.hostname,
			pid = EXCLUDED.pid,
			version = EXCLUDED.version,
			state = 'active',
			last_heartbeat_at = now(),
			heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds,
			queues = EXCLUDED.queues,
			handlers = EXCLUDED.handlers,
			max_concurrency = EXCLUDED.max_concurrency
	`
	_, err := s.pool.Exec(ctx, insertSQL,
		p.ID, p.Hostname, p.PID, p.Version, p.HeartbeatIntervalSeconds,
		p.Queues, p.Handlers, p.MaxConcurrency,
	)
	if err != nil {
		return nil, fmt.Errorf("workers.RegisterWorker: %w", err)
	}
	return s.GetWorker(ctx, p.ID)
}

func (s *pgWorkerStore) HeartbeatWorker(ctx context.Context, id string) (*heartbeatResponse, error) {
	const sql = `
		UPDATE workers
		SET last_heartbeat_at = now()
		WHERE id = $1 AND state != 'disconnected'
		RETURNING id, state::text, last_heartbeat_at
	`
	var hb heartbeatResponse
	err := s.pool.QueryRow(ctx, sql, id).Scan(&hb.ID, &hb.State, &hb.LastHeartbeatAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.HeartbeatWorker: %w", err)
	}
	return &hb, nil
}

func (s *pgWorkerStore) ClaimJob(ctx context.Context, id string, queues, handlers []string) (*queuecore.Job, error) {
	var (
		state       string
		regQueues   []string
		regHandlers []string
	)
	err := s.pool.QueryRow(ctx, "SELECT state::text, queues, handlers FROM workers WHERE id = $1", id).
		Scan(&state, &regQueues, &regHandlers)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		return nil, fmt.Errorf("workers.ClaimJob: check worker: %w", err)
	}
	if state == "disconnected" {
		return nil, ErrWorkerNotFound
	}
	if state == "cordoned" || state == "draining" {
		return nil, nil
	}

	claimQueues := queues
	if len(claimQueues) == 0 {
		claimQueues = regQueues
	}
	claimHandlers := handlers
	if len(claimHandlers) == 0 {
		claimHandlers = regHandlers
	}
	if len(claimQueues) == 0 || len(claimHandlers) == 0 {
		return nil, errors.New("no queues or handlers configured for worker")
	}

	return s.repo.ClaimNextJob(ctx, id, claimQueues, claimHandlers)
}

func (s *pgWorkerStore) RenewJobLease(ctx context.Context, workerID, jobID string) (*queuecore.Job, error) {
	return s.repo.RenewLease(ctx, queuecore.RenewParams{
		WorkerID: workerID,
		JobID:    jobID,
	})
}

func (s *pgWorkerStore) CompleteJob(ctx context.Context, workerID, jobID string, result json.RawMessage) (*queuecore.Job, error) {
	job, err := s.repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: workerID,
		JobID:    jobID,
		Result:   result,
	})
	if err != nil {
		return nil, err
	}
	_, _ = s.pool.Exec(ctx, "UPDATE workers SET total_processed = total_processed + 1 WHERE id = $1", workerID)
	return job, nil
}

func (s *pgWorkerStore) FailJob(ctx context.Context, workerID, jobID string, jerr queuecore.JobError, permanent bool) (*queuecore.Job, error) {
	job, err := s.repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID:  workerID,
		JobID:     jobID,
		Error:     jerr,
		Permanent: permanent,
	})
	if err != nil {
		return nil, err
	}
	_, _ = s.pool.Exec(ctx, "UPDATE workers SET total_processed = total_processed + 1 WHERE id = $1", workerID)
	return job, nil
}

func badRequest(c fiber.Ctx, msg string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg})
}

func internalError(c fiber.Ctx, err error) error {
	slog.ErrorContext(c.Context(), "workers.internal_error",
		"event", "workers.internal_error",
		"path", c.Path(),
		"method", c.Method(),
		"err", err.Error(),
	)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal server error"})
}
