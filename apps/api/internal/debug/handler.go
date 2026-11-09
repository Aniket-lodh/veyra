// Package debug exposes internal queue poke routes for curl.
package debug

import (
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler holds only the queue repository; debug endpoints do not own any other state.
type Handler struct {
	repo *queuecore.Repository
}

func NewHandler(repo *queuecore.Repository) *Handler {
	return &Handler{repo: repo}
}

// Register mounts every debug route under /internal/debug/.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Post("/internal/debug/claim", authn.Require(auth.ScopeDebug), h.Claim)
	app.Post("/internal/debug/succeed", authn.Require(auth.ScopeDebug), h.Succeed)
	app.Post("/internal/debug/fail", authn.Require(auth.ScopeDebug), h.Fail)
	app.Post("/internal/debug/renew", authn.Require(auth.ScopeDebug), h.Renew)
}

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

// Claim drives queuecore.ClaimNextJob.
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

// Fail drives queuecore.MarkJobFailed.
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

// Renew drives queuecore.RenewLease (SPEC §4).
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

// toDebugJob serialises a queuecore.Job for debug callers.
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

// mapCompletionError maps the queuecore sentinels to HTTP codes.
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
