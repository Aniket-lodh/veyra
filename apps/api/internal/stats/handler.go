// Package stats serves dashboard aggregate queue metrics.
package stats

import (
	"log/slog"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type Handler struct {
	repo *queuecore.Repository
}

func NewHandler(repo *queuecore.Repository) *Handler {
	return &Handler{repo: repo}
}

// Register mounts GET /queue/stats on the fiber app.
func Register(app *fiber.App, h *Handler, authn *auth.Authenticator) {
	app.Get("/queue/stats", authn.Require(auth.ScopeQueueRead), h.Get)
}

// totalsResponse is the global counts surface.
type totalsResponse struct {
	Queued       int `json:"queued"`
	Scheduled    int `json:"scheduled"`
	Running      int `json:"running"`
	Succeeded    int `json:"succeeded"`
	Failed       int `json:"failed"`
	DeadLettered int `json:"deadLettered"`
	Cancelled    int `json:"cancelled"`
}

// queueResponse is the per-queue surface.
type queueResponse struct {
	Name            string `json:"name"`
	Depth           int    `json:"depth"`
	InFlight        int    `json:"inFlight"`
	Succeeded24h    int    `json:"succeeded24h"`
	Failed24h       int    `json:"failed24h"`
	DeadLettered24h int    `json:"deadLettered24h"`
}

type statsResponse struct {
	Totals totalsResponse  `json:"totals"`
	Queues []queueResponse `json:"queues"`
}

// Get returns the dashboard snapshot.
func (h *Handler) Get(c fiber.Ctx) error {
	stats, err := h.repo.QueueStats(c.Context())
	if err != nil {
		slog.ErrorContext(c.Context(), "stats.internal_error",
			"event", "stats.internal_error",
			"path", c.Path(),
			"err", err.Error(),
		)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	resp := statsResponse{
		Totals: totalsResponse{
			Queued:       stats.Totals.Queued,
			Scheduled:    stats.Totals.Scheduled,
			Running:      stats.Totals.Running,
			Succeeded:    stats.Totals.Succeeded,
			Failed:       stats.Totals.Failed,
			DeadLettered: stats.Totals.DeadLettered,
			Cancelled:    stats.Totals.Cancelled,
		},
		Queues: make([]queueResponse, 0, len(stats.PerQueue)),
	}
	for _, q := range stats.PerQueue {
		resp.Queues = append(resp.Queues, queueResponse{
			Name:            q.Name,
			Depth:           q.Depth,
			InFlight:        q.InFlight,
			Succeeded24h:    q.Succeeded24h,
			Failed24h:       q.Failed24h,
			DeadLettered24h: q.DeadLettered24h,
		})
	}
	return c.JSON(resp)
}
