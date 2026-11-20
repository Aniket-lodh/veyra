// Package workers is the HTTP layer and sweeper for the workers table.
package workers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

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
	app.Get("/workers/:id", authn.Require(auth.ScopeQueueRead), h.GetByID)
	app.Post("/workers/:id/leases/:jobId/release", authn.Require(auth.ScopeJobsWrite), h.ReleaseLease)
	app.Post("/workers/:id/drain", authn.Require(auth.ScopeJobsWrite), h.Drain)
	app.Post("/workers/:id/cordon", authn.Require(auth.ScopeJobsWrite), h.Cordon)
	app.Patch("/workers/:id/cordon", authn.Require(auth.ScopeJobsWrite), h.Cordon)
	app.Post("/workers/:id/resume", authn.Require(auth.ScopeJobsWrite), h.Resume)
	app.Patch("/workers/:id/resume", authn.Require(auth.ScopeJobsWrite), h.Resume)
	app.Delete("/workers/:id", authn.Require(auth.ScopeJobsWrite), h.Deregister)
	app.Post("/workers/:id/deregister", authn.Require(auth.ScopeJobsWrite), h.Deregister)
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
