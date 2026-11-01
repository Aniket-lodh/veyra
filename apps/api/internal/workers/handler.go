// Package workers is the HTTP layer for the operator UI's Workers View. It
// owns SQL against the `workers` table directly — this is intentional and
// distinct from queue-core's ownership of the `jobs` table. The workers
// table is observability-only (see migration 000002 and the
// "no JOIN to workers in dequeue" rule): the dequeue hot path never reads
// it, so keeping its SQL out of queue-core preserves the queue's locking
// boundary.
//
// One endpoint: GET /workers. It returns every worker row together with
// the leases it currently holds. Leases are sourced from queue-core's
// ListRunningLeases (since they live in the jobs table) and zipped onto
// the worker rows in-process; the database never joins workers ↔ jobs.
//
// What this package does NOT do:
//   - heartbeat upserts (those belong on the worker side, written via
//     internal/workerregistry or similar — not present yet)
//   - state mutations (start drain, force-disconnect) — those will be
//     POST endpoints when the operator UI grows past Phase 0
package workers

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler is the apps/api binding for workers-table reads. It needs both
// the raw pool (for the workers table) and a queue-core repository (for
// the lease join). The two are wired separately in main.go.
type Handler struct {
	pool *pgxpool.Pool
	repo *queuecore.Repository
}

func NewHandler(pool *pgxpool.Pool, repo *queuecore.Repository) *Handler {
	return &Handler{pool: pool, repo: repo}
}

// Register mounts GET /workers.
func Register(app *fiber.App, h *Handler) {
	app.Get("/workers", h.List)
}

// leaseResponse mirrors the frontend WorkerLease interface. leasedAt is
// the job's started_at (per-attempt start). leaseExpiresAt is the
// authoritative deadline from jobs.lease_expires_at.
type leaseResponse struct {
	JobID          string `json:"jobId"`
	Handler        string `json:"handler"`
	Queue          string `json:"queue"`
	Attempt        int    `json:"attempt"`
	LeasedAt       string `json:"leasedAt"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

// workerResponse mirrors the frontend Worker interface. id is the
// ephemeral runtime id (fresh ULID per process boot); hostname + version
// are the stable identity an operator follows across restarts.
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

// List handles GET /workers. Returns the full roster — no pagination yet;
// a single VPS-scale deployment has tens of workers at most. When that
// stops being true, add ?limit/offset the way /jobs has them.
func (h *Handler) List(c fiber.Ctx) error {
	ctx := c.Context()
	rows, err := h.queryWorkers(ctx)
	if err != nil {
		return internalError(c, err)
	}

	// Build the worker_id → leases map in one pgxpool call. Passing an
	// empty slice would return every running lease in the database; we
	// pass the worker ids we actually have so the lease query is bounded.
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

// queryWorkers reads the workers table verbatim. The dequeue path does not
// touch this table, so a plain ORDER BY started_at DESC is safe — there is
// no contention from the queue hot path with this read.
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
