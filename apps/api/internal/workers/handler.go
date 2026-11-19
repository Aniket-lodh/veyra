// Package workers is the HTTP layer and sweeper for the workers table.
package workers

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler is the apps/api binding for workers-table reads.
type Handler struct {
	pool *pgxpool.Pool
	repo *queuecore.Repository
}

func NewHandler(pool *pgxpool.Pool, repo *queuecore.Repository) *Handler {
	return &Handler{pool: pool, repo: repo}
}

// Register mounts GET /workers.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Get("/workers", authn.Require(auth.ScopeQueueRead), h.List)
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
	rows, err := h.queryWorkers(ctx)
	if err != nil {
		return internalError(c, err)
	}

	// Build the worker_id → leases map in one pgxpool call.
	workerIDs := make([]string, 0, len(rows))
	for _, w := range rows {
		workerIDs = append(workerIDs, w.ID)
	}
	leasesByWorker := make(map[string][]leaseResponse, len(workerIDs))
	if len(workerIDs) > 0 {
		leases, err := h.repo.ListRunningLeases(ctx, workerIDs)
		if err != nil {
			return internalError(c, err)
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

	return c.JSON(fiber.Map{"workers": out})
}

// queryWorkers reads the workers table verbatim.
func (h *Handler) queryWorkers(ctx context.Context) ([]workerResponse, error) {
	const query = `
		SELECT id, hostname, pid, version, state::text,
		       started_at, last_heartbeat_at, heartbeat_interval_seconds,
		       queues, handlers, max_concurrency, total_processed
		FROM workers
		ORDER BY started_at DESC, id ASC
	`
	rs, err := h.pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("workers.queryWorkers: query: %w", err)
	}
	defer rs.Close()

	out := make([]workerResponse, 0)
	for rs.Next() {
		var w workerResponse
		if err := rs.Scan(
			&w.ID, &w.Hostname, &w.PID, &w.Version, &w.State,
			&w.StartedAt, &w.LastHeartbeatAt, &w.HeartbeatIntervalSeconds,
			&w.Queues, &w.Handlers, &w.MaxConcurrency, &w.TotalProcessed,
		); err != nil {
			return nil, fmt.Errorf("workers.queryWorkers: scan: %w", err)
		}
		// Initialize so JSON encodes [] instead of null for the empty case.
		w.Leases = []leaseResponse{}
		out = append(out, w)
	}
	if err := rs.Err(); err != nil {
		return nil, fmt.Errorf("workers.queryWorkers: rows: %w", err)
	}
	return out, nil
}

func internalError(c fiber.Ctx, err error) error {
	slog.ErrorContext(c.Context(), "workers.internal_error",
		"event", "workers.internal_error",
		"path", c.Path(),
		"method", c.Method(),
		"err", err.Error(),
	)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}
