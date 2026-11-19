// Package jobs is the HTTP layer for queue operations.
package jobs

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/oklog/ulid/v2"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

const (
	defaultPriority    = 5
	defaultMaxAttempts = 3

	defaultListLimit = 50
	maxListLimit     = 200
)

// Handler holds the dependencies the job HTTP routes need.
type Handler struct {
	repo *queuecore.Repository
}

func NewHandler(repo *queuecore.Repository) *Handler {
	return &Handler{repo: repo}
}

// Register mounts the job routes on the fiber app.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Post("/jobs", authn.Require(auth.ScopeJobsWrite), h.Create)
	app.Get("/jobs", authn.Require(auth.ScopeJobsRead), h.List)
	app.Get("/jobs/:id", authn.Require(auth.ScopeJobsRead), h.GetByID)
	app.Post("/jobs/:id/cancel", authn.Require(auth.ScopeJobsWrite), h.Cancel)
}

// createRequest is the POST /jobs body.
type createRequest struct {
	Handler        string                     `json:"handler"`
	Queue          string                     `json:"queue"`
	Payload        json.RawMessage            `json:"payload"`
	Priority       *int                       `json:"priority,omitempty"`
	MaxAttempts    *int                       `json:"maxAttempts,omitempty"`
	Backoff        *queuecore.BackoffStrategy `json:"backoff,omitempty"`
	ScheduledFor   *time.Time                 `json:"scheduledFor,omitempty"`
	IdempotencyKey *string                    `json:"idempotencyKey,omitempty"`
}

// jobResponse is the API view of a Job.
type jobResponse struct {
	ID             string `json:"id"`
	Handler        string `json:"handler"`
	Queue          string `json:"queue"`
	Status         string `json:"status"` // API-derived (7 values, includes 'scheduled' and 'dead-lettered')
	Priority       int    `json:"priority"`
	IdempotencyKey any    `json:"idempotencyKey"`

	Payload json.RawMessage     `json:"payload"`
	Result  any                 `json:"result"`
	Error   *queuecore.JobError `json:"error"`

	Attempt     int                       `json:"attempt"`
	MaxAttempts int                       `json:"maxAttempts"`
	Backoff     queuecore.BackoffStrategy `json:"backoff"`

	EnqueuedAt     time.Time  `json:"enqueuedAt"`
	ScheduledFor   *time.Time `json:"scheduledFor"`
	StartedAt      *time.Time `json:"startedAt"`
	CompletedAt    *time.Time `json:"completedAt"`
	CancelledAt    *time.Time `json:"cancelledAt"`
	DeadLetteredAt *time.Time `json:"deadLetteredAt"`

	CurrentWorkerID *string    `json:"currentWorkerId"`
	LeaseExpiresAt  *time.Time `json:"leaseExpiresAt"`
	NextRetryAt     *time.Time `json:"nextRetryAt"`

	Attempts []attemptResponse `json:"attempts"`
}

// attemptResponse is the API view of one job_attempts row.
type attemptResponse struct {
	AttemptNumber int        `json:"attemptNumber"`
	WorkerID      string     `json:"workerId"`
	StartedAt     time.Time  `json:"startedAt"`
	EndedAt       *time.Time `json:"endedAt"`
	DurationMs    *int64     `json:"durationMs"`
	Outcome       *string    `json:"outcome"`
	ErrorClass    *string    `json:"errorClass"`
	ErrorMessage  *string    `json:"errorMessage"`
}

// toAttemptResponse converts the stored shape to the API shape, renaming the lease_lost outcome to "lease-lost" (mirroring dead_lettered →…
func toAttemptResponse(a *queuecore.Attempt) attemptResponse {
	var (
		outcome    *string
		durationMs *int64
	)
	if a.Outcome != nil {
		s := string(*a.Outcome)
		if s == string(queuecore.OutcomeLeaseLost) {
			s = "lease-lost"
		}
		outcome = &s
	}
	if a.EndedAt != nil {
		d := a.EndedAt.Sub(a.StartedAt).Milliseconds()
		durationMs = &d
	}
	return attemptResponse{
		AttemptNumber: a.AttemptNumber,
		WorkerID:      a.WorkerID,
		StartedAt:     a.StartedAt,
		EndedAt:       a.EndedAt,
		DurationMs:    durationMs,
		Outcome:       outcome,
		ErrorClass:    a.ErrorClass,
		ErrorMessage:  a.ErrorMessage,
	}
}

// toResponse maps a stored Job to the API shape, deriving the API-only "scheduled" status and renaming "dead_lettered" → "dead-lettered".
func toResponse(j *queuecore.Job) jobResponse {
	var idempotencyKey any
	if j.IdempotencyKey != nil {
		idempotencyKey = *j.IdempotencyKey
	}
	var result any
	if len(j.Result) > 0 {
		result = json.RawMessage(j.Result)
	}
	scheduledFor := &j.ScheduledFor

	return jobResponse{
		ID:              j.ID,
		Handler:         j.Handler,
		Queue:           j.Queue,
		Status:          deriveAPIStatus(j.Status, j.ScheduledFor, time.Now()),
		Priority:        j.Priority,
		IdempotencyKey:  idempotencyKey,
		Payload:         j.Payload,
		Result:          result,
		Error:           j.Error,
		Attempt:         j.Attempt,
		MaxAttempts:     j.MaxAttempts,
		Backoff:         j.Backoff,
		EnqueuedAt:      j.EnqueuedAt,
		ScheduledFor:    scheduledFor,
		StartedAt:       j.StartedAt,
		CompletedAt:     j.CompletedAt,
		CancelledAt:     j.CancelledAt,
		DeadLetteredAt:  j.DeadLetteredAt,
		CurrentWorkerID: j.CurrentWorkerID,
		LeaseExpiresAt:  j.LeaseExpiresAt,
		NextRetryAt:     j.NextRetryAt,
		Attempts:        []attemptResponse{},
	}
}

// deriveAPIStatus converts the 6-value storage enum to the 7-value API vocabulary.
func deriveAPIStatus(status queuecore.JobStatus, scheduledFor time.Time, now time.Time) string {
	if status == queuecore.StatusQueued && scheduledFor.After(now) {
		return "scheduled"
	}
	if status == queuecore.StatusDeadLettered {
		return "dead-lettered"
	}
	return string(status)
}

// Create handles POST /jobs.
func (h *Handler) Create(c fiber.Ctx) error {
	var req createRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return badRequest(c, "invalid JSON body: "+err.Error())
	}

	params, err := buildCreateParams(req)
	if err != nil {
		return badRequest(c, err.Error())
	}

	job, err := h.repo.Create(c.Context(), params)
	if err != nil {
		return internalError(c, err)
	}
	slog.InfoContext(c.Context(), "jobs.create",
		"event", "jobs.create",
		"jobId", job.ID,
		"queue", job.Queue,
		"handler", job.Handler,
		"priority", job.Priority,
		"maxAttempts", job.MaxAttempts,
	)
	return c.Status(fiber.StatusCreated).JSON(toResponse(job))
}

// Cancel handles POST /jobs/:id/cancel.
func (h *Handler) Cancel(c fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return badRequest(c, "id is required")
	}
	ctx := c.Context()
	job, err := h.repo.Cancel(ctx, queuecore.CancelParams{JobID: id})
	if err != nil {
		if errors.Is(err, queuecore.ErrJobNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
		}
		if errors.Is(err, queuecore.ErrNotCancellable) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error": "job is not cancellable: already succeeded or dead-lettered",
			})
		}
		return internalError(c, err)
	}
	slog.InfoContext(ctx, "jobs.cancel",
		"event", "jobs.cancel",
		"jobId", job.ID,
		"status", string(job.Status),
	)
	attempts, err := h.repo.ListAttempts(ctx, id)
	if err != nil {
		return internalError(c, err)
	}
	resp := toResponse(job)
	resp.Attempts = make([]attemptResponse, 0, len(attempts))
	for _, a := range attempts {
		resp.Attempts = append(resp.Attempts, toAttemptResponse(a))
	}
	return c.JSON(resp)
}

// GetByID handles GET /jobs/:id.
func (h *Handler) GetByID(c fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return badRequest(c, "id is required")
	}
	ctx := c.Context()
	job, err := h.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, queuecore.ErrJobNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "job not found"})
		}
		return internalError(c, err)
	}
	attempts, err := h.repo.ListAttempts(ctx, id)
	if err != nil {
		return internalError(c, err)
	}
	resp := toResponse(job)
	resp.Attempts = make([]attemptResponse, 0, len(attempts))
	for _, a := range attempts {
		resp.Attempts = append(resp.Attempts, toAttemptResponse(a))
	}
	return c.JSON(resp)
}

// List handles GET /jobs.
func (h *Handler) List(c fiber.Ctx) error {
	limit, err := parsePositiveQuery(c, "limit", defaultListLimit)
	if err != nil {
		return badRequest(c, err.Error())
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	offset, err := parsePositiveQuery(c, "offset", 0)
	if err != nil {
		return badRequest(c, err.Error())
	}

	statuses, err := parseStatusFilter(c)
	if err != nil {
		return badRequest(c, err.Error())
	}

	params := queuecore.ListParams{
		Limit:    limit,
		Offset:   offset,
		Statuses: statuses,
		Queues:   repeatedQuery(c, "queue"),
		Handlers: repeatedQuery(c, "handler"),
		Search:   strings.TrimSpace(c.Query("search")),
	}

	ctx := c.Context()
	jobs, err := h.repo.List(ctx, params)
	if err != nil {
		return internalError(c, err)
	}
	total, err := h.repo.Count(ctx, params)
	if err != nil {
		return internalError(c, err)
	}

	out := make([]jobResponse, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, toResponse(j))
	}
	return c.JSON(fiber.Map{
		"jobs":       out,
		"totalCount": total,
		"limit":      limit,
		"offset":     offset,
	})
}

// buildCreateParams validates the request and resolves defaults.
func buildCreateParams(req createRequest) (queuecore.CreateParams, error) {
	handler := strings.TrimSpace(req.Handler)
	if handler == "" {
		return queuecore.CreateParams{}, errors.New("handler is required")
	}
	queue := strings.TrimSpace(req.Queue)
	if queue == "" {
		return queuecore.CreateParams{}, errors.New("queue is required")
	}
	if len(req.Payload) == 0 {
		return queuecore.CreateParams{}, errors.New("payload is required")
	}
	if !json.Valid(req.Payload) {
		return queuecore.CreateParams{}, errors.New("payload must be valid JSON")
	}

	priority := defaultPriority
	if req.Priority != nil {
		priority = *req.Priority
		if priority < 0 || priority > 9 {
			return queuecore.CreateParams{}, errors.New("priority must be between 0 and 9")
		}
	}

	maxAttempts := defaultMaxAttempts
	if req.MaxAttempts != nil {
		maxAttempts = *req.MaxAttempts
		if maxAttempts < 1 {
			return queuecore.CreateParams{}, errors.New("maxAttempts must be >= 1")
		}
	}

	backoff := queuecore.DefaultBackoff()
	if req.Backoff != nil {
		backoff = *req.Backoff
		if err := backoff.Validate(); err != nil {
			return queuecore.CreateParams{}, err
		}
	}

	var idempotencyKey *string
	if req.IdempotencyKey != nil {
		trimmed := strings.TrimSpace(*req.IdempotencyKey)
		if trimmed != "" {
			idempotencyKey = &trimmed
		}
	}

	return queuecore.CreateParams{
		ID:             ulid.Make().String(),
		Handler:        handler,
		Queue:          queue,
		Priority:       priority,
		MaxAttempts:    maxAttempts,
		Backoff:        backoff,
		Payload:        req.Payload,
		ScheduledFor:   req.ScheduledFor,
		IdempotencyKey: idempotencyKey,
	}, nil
}

func parsePositiveQuery(c fiber.Ctx, key string, def int) (int, error) {
	raw := c.Query(key)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, errors.New(key + " must be an integer")
	}
	if v < 0 {
		return 0, errors.New(key + " must be >= 0")
	}
	return v, nil
}

// repeatedQuery reads every occurrence of `key` from the URL query string, e.g.
func repeatedQuery(c fiber.Ctx, key string) []string {
	raw := c.RequestCtx().QueryArgs().PeekMulti(key)
	if len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, b := range raw {
		s := strings.TrimSpace(string(b))
		if s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseStatusFilter reads repeated ?status= query values and translates the frontend's 7-value API vocabulary to the 6-value storage enum.
func parseStatusFilter(c fiber.Ctx) ([]queuecore.JobStatus, error) {
	raw := repeatedQuery(c, "status")
	if len(raw) == 0 {
		return nil, nil
	}
	seen := make(map[queuecore.JobStatus]struct{}, len(raw))
	out := make([]queuecore.JobStatus, 0, len(raw))
	for _, name := range raw {
		mapped, ok := apiStatusToStorage(name)
		if !ok {
			return nil, fmt.Errorf("unknown status %q", name)
		}
		if _, dup := seen[mapped]; dup {
			continue
		}
		seen[mapped] = struct{}{}
		out = append(out, mapped)
	}
	return out, nil
}

// apiStatusToStorage maps an API status name (7 values) to the storage enum (6 values).
func apiStatusToStorage(api string) (queuecore.JobStatus, bool) {
	switch api {
	case "queued", "scheduled":
		return queuecore.StatusQueued, true
	case "running":
		return queuecore.StatusRunning, true
	case "succeeded":
		return queuecore.StatusSucceeded, true
	case "failed":
		return queuecore.StatusFailed, true
	case "dead-lettered":
		return queuecore.StatusDeadLettered, true
	case "cancelled":
		return queuecore.StatusCancelled, true
	default:
		return "", false
	}
}

func badRequest(c fiber.Ctx, msg string) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": msg})
}

func internalError(c fiber.Ctx, err error) error {
	// Always log the cause — the response body alone is not enough for operators (the access log records the 500, but not WHY).
	slog.ErrorContext(c.Context(), "jobs.internal_error",
		"event", "jobs.internal_error",
		"path", c.Path(),
		"method", c.Method(),
		"err", err.Error(),
	)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}
