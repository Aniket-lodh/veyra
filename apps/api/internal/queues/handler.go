// Package queues serves operational queue control endpoints (pause, resume).
package queues

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	"github.com/Aniket-lodh/veyra/api/internal/live"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type queueRepository interface {
	PauseQueue(ctx context.Context, p queuecore.PauseQueueParams) (*queuecore.QueueState, error)
	ResumeQueue(ctx context.Context, p queuecore.ResumeQueueParams) (*queuecore.QueueState, error)
	GetQueueState(ctx context.Context, queueName string) (*queuecore.QueueState, error)
}

type eventBroadcaster interface {
	MarkDirty(resources ...string)
}

type Handler struct {
	repo        queueRepository
	broadcaster eventBroadcaster
}

func NewHandler(repo queueRepository, broadcaster ...eventBroadcaster) *Handler {
	var b eventBroadcaster
	if len(broadcaster) > 0 {
		b = broadcaster[0]
	}
	return &Handler{repo: repo, broadcaster: b}
}

// Register mounts queue pause and resume routes on the fiber app.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Post("/queues/:name/pause", authn.Require(auth.ScopeJobsWrite), h.Pause)
	app.Post("/queues/:name/resume", authn.Require(auth.ScopeJobsWrite), h.Resume)
}

type pauseRequest struct {
	Reason string `json:"reason,omitempty"`
}

type queueStateResponse struct {
	Queue        string     `json:"queue"`
	Paused       bool       `json:"paused"`
	PausedAt     *time.Time `json:"pausedAt,omitempty"`
	PausedReason *string    `json:"pausedReason,omitempty"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

func toResponse(qs *queuecore.QueueState) queueStateResponse {
	return queueStateResponse{
		Queue:        qs.QueueName,
		Paused:       qs.Paused,
		PausedAt:     qs.PausedAt,
		PausedReason: qs.PausedReason,
		UpdatedAt:    qs.UpdatedAt,
	}
}

// validateQueueName validates and normalizes an input queue name.
func validateQueueName(raw string) (string, error) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", errors.New("malformed queue name encoding")
	}
	trimmed := strings.TrimSpace(decoded)
	if trimmed == "" {
		return "", errors.New("queue name cannot be empty")
	}
	if len(trimmed) > 128 {
		return "", errors.New("queue name exceeds maximum length of 128 characters")
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return "", errors.New("queue name contains whitespace or control characters")
		}
	}
	return trimmed, nil
}

// Pause pauses job claiming on the named queue.
func (h *Handler) Pause(c fiber.Ctx) error {
	queueName, err := validateQueueName(c.Params("name"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid queue name: " + err.Error(),
		})
	}

	var req pauseRequest
	body := c.Body()
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "malformed request body",
			})
		}
	}

	qs, err := h.repo.PauseQueue(c.Context(), queuecore.PauseQueueParams{
		QueueName: queueName,
		Reason:    req.Reason,
	})
	if err != nil {
		slog.ErrorContext(c.Context(), "queues.pause.internal_error",
			"event", "queues.pause.internal_error",
			"path", c.Path(),
			"queue", queueName,
			"err", err.Error(),
		)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "internal server error",
		})
	}

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty(live.ResourceStats, live.ResourceJobs, "queues")
	}

	return c.Status(fiber.StatusOK).JSON(toResponse(qs))
}

// Resume resumes job claiming on the named queue.
func (h *Handler) Resume(c fiber.Ctx) error {
	queueName, err := validateQueueName(c.Params("name"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid queue name: " + err.Error(),
		})
	}

	qs, err := h.repo.ResumeQueue(c.Context(), queuecore.ResumeQueueParams{
		QueueName: queueName,
	})
	if err != nil {
		slog.ErrorContext(c.Context(), "queues.resume.internal_error",
			"event", "queues.resume.internal_error",
			"path", c.Path(),
			"queue", queueName,
			"err", err.Error(),
		)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "internal server error",
		})
	}

	if h.broadcaster != nil {
		h.broadcaster.MarkDirty(live.ResourceStats, live.ResourceJobs, "queues")
	}

	return c.Status(fiber.StatusOK).JSON(toResponse(qs))
}
