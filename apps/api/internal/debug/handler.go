// Package debug owns HTTP routes that exist to poke the queue from curl.
// They are not part of the product surface — they are an operator tool.
//
// Today the routes shadow ClaimNextJob / MarkJobSucceeded / MarkJobFailed /
// RenewLease so the queue's primitives can be exercised by hand against a
// real database, independent of the worker. Even now that apps/worker exists
// and drives these in-process, having a curl-able surface is still the
// fastest way to:
//
//   - reproduce a reclaim race (claim from worker, claim again from curl)
//   - test §1.5.2 budget-exhausted reclaim DLQ without crashing a worker
//   - validate SPEC §4 lease renewal by hand
//
// All routes mount under /internal/debug/* and have no auth. They are NOT
// safe to expose externally; the central HTTP server is expected to reject
// /internal/* at the ingress in production.
package debug

import (
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v3"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler holds only the queue repository; debug endpoints do not own any
// other state. Keep it that way — every extra dependency widens the surface
// that this dev-only package can break.
type Handler struct {
	repo *queuecore.Repository
}

func NewHandler(repo *queuecore.Repository) *Handler {
	return &Handler{repo: repo}
}

// Register mounts every debug route under /internal/debug/. Removing all debug
// endpoints is two lines: drop the call site in cmd/api/main.go and delete
// this package.
func Register(app *fiber.App, h *Handler) {
	app.Post("/internal/debug/claim", h.Claim)
	app.Post("/internal/debug/succeed", h.Succeed)
	app.Post("/internal/debug/fail", h.Fail)
	app.Post("/internal/debug/renew", h.Renew)
}

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

type claimReq struct {
	WorkerID string   `json:"workerId"`
	Queues   []string `json:"queues"`
	Handlers []string `json:"handlers"`
}

type succeedReq struct {
	WorkerID string          `json:"workerId"`
	JobID    string          `json:"jobId"`
	Result   json.RawMessage `json:"result,omitempty"`
}

type failReq struct {
	WorkerID string              `json:"workerId"`
	JobID    string              `json:"jobId"`
	Error    *queuecore.JobError `json:"error"`
}

type renewReq struct {
	WorkerID string `json:"workerId"`
	JobID    string `json:"jobId"`
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

// Claim drives queuecore.ClaimNextJob. Returns JSON null when nothing matches
// the predicate — same convention as the worker observes in-process.
func (h *Handler) Claim(c fiber.Ctx) error {
	var req claimReq
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}
	if req.WorkerID == "" {
		return badRequest(c, "workerId is required")
	}
	if len(req.Queues) == 0 {
		return badRequest(c, "queues must be a non-empty array")
	}
	if len(req.Handlers) == 0 {
		return badRequest(c, "handlers must be a non-empty array")
	}

	job, err := h.repo.ClaimNextJob(c.Context(), req.WorkerID, req.Queues, req.Handlers)
	if err != nil {
		return internalError(c, err)
	}
	if job == nil {
		return c.JSON(nil)
	}
	return c.JSON(toDebugJob(job))
}

// Succeed drives queuecore.MarkJobSucceeded.
func (h *Handler) Succeed(c fiber.Ctx) error {
	var req succeedReq
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}
	if req.WorkerID == "" {
		return badRequest(c, "workerId is required")
	}
	if req.JobID == "" {
		return badRequest(c, "jobId is required")
	}
	job, err := h.repo.MarkJobSucceeded(c.Context(), queuecore.SucceedParams{
		WorkerID: req.WorkerID,
		JobID:    req.JobID,
		Result:   req.Result,
	})
	if err != nil {
		return mapCompletionError(c, err)
	}
	return c.JSON(toDebugJob(job))
}

// Fail drives queuecore.MarkJobFailed. error.class and error.message are
// required; the queue applies its own defaults to occurredAt and stackTrace.
func (h *Handler) Fail(c fiber.Ctx) error {
	var req failReq
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}
	if req.WorkerID == "" {
		return badRequest(c, "workerId is required")
	}
	if req.JobID == "" {
		return badRequest(c, "jobId is required")
	}
	if req.Error == nil {
		return badRequest(c, "error is required")
	}
	job, err := h.repo.MarkJobFailed(c.Context(), queuecore.FailParams{
		WorkerID: req.WorkerID,
		JobID:    req.JobID,
		Error:    *req.Error,
	})
	if err != nil {
		return mapCompletionError(c, err)
	}
	return c.JSON(toDebugJob(job))
}

// Renew drives queuecore.RenewLease (SPEC §4). 200 on success with the
// updated job, 409 on lease-lost/expired, 404 on not-found. Exists so the
// operator can simulate a renewal heartbeat without running a worker.
func (h *Handler) Renew(c fiber.Ctx) error {
	var req renewReq
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}
	if req.WorkerID == "" {
		return badRequest(c, "workerId is required")
	}
	if req.JobID == "" {
		return badRequest(c, "jobId is required")
	}
	job, err := h.repo.RenewLease(c.Context(), queuecore.RenewParams{
		WorkerID: req.WorkerID,
		JobID:    req.JobID,
	})
	if err != nil {
		return mapCompletionError(c, err)
	}
	return c.JSON(toDebugJob(job))
}

// -----------------------------------------------------------------------------
// Helpers (deliberately local; debug must not depend on jobs/ shape)
// -----------------------------------------------------------------------------

// toDebugJob serialises a queuecore.Job for debug callers. Deliberately a
// minimal projection — debug endpoints should not mirror the public API
// shape because that creates two parallel schemas to keep in sync. The
// public response shape lives in internal/jobs and is owned by that package.
func toDebugJob(j *queuecore.Job) fiber.Map {
	return fiber.Map{
		"id":              j.ID,
		"queue":           j.Queue,
		"handler":         j.Handler,
		"status":          string(j.Status),
		"attempt":         j.Attempt,
		"maxAttempts":     j.MaxAttempts,
		"currentWorkerId": j.CurrentWorkerID,
		"leaseExpiresAt":  j.LeaseExpiresAt,
		"nextRetryAt":     j.NextRetryAt,
	}
}

// mapCompletionError maps the queuecore sentinels to HTTP codes. 404 for
// missing, 409 for lease-lost/expired (caller is wrong, not the server), 500
// for anything else.
func mapCompletionError(c fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, queuecore.ErrJobNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
	case errors.Is(err, queuecore.ErrLeaseLost):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "lease lost", "detail": err.Error()})
	case errors.Is(err, queuecore.ErrLeaseExpired):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "lease expired", "detail": err.Error()})
	default:
		return internalError(c, err)
	}
}

func badRequest(c fiber.Ctx, msg string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg})
}

func internalError(c fiber.Ctx, err error) error {
	slog.ErrorContext(c.Context(), "debug.internal_error", "err", err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}
