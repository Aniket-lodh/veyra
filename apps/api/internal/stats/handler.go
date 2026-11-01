// Package stats is the HTTP layer for the operator dashboard's aggregate
// view. One endpoint, GET /queue/stats: it returns the snapshot the
// dashboard renders. The SQL behind it lives in queue-core (since all
// jobs-table SQL ownership lives there); this package is the API skin.
//
// Latency percentiles and throughput-per-minute are deliberately omitted
// from this surface — they require a time-series store the system does
// not yet have. The frontend renders them as `null` until they exist,
// rather than the API faking values.
package stats

import (
	"log/slog"

	"github.com/gofiber/fiber/v3"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type Handler struct {
	repo *queuecore.Repository
}

func NewHandler(repo *queuecore.Repository) *Handler {
	return &Handler{repo: repo}
}

// Register mounts GET /queue/stats on the fiber app.
func Register(app *fiber.App, h *Handler) {
	app.Get("/queue/stats", h.Get)
}

// totalsResponse is the global counts surface. Field names match the
// frontend status vocabulary (camelCase, the 7-value enum including the
// derived `scheduled` and the renamed `dead-lettered`).
type totalsResponse struct {
	Queued       int `json:"queued"`
	Scheduled    int `json:"scheduled"`
	Running      int `json:"running"`
	Succeeded    int `json:"succeeded"`
	Failed       int `json:"failed"`
	DeadLettered int `json:"deadLettered"`
	Cancelled    int `json:"cancelled"`
}

// queueResponse is the per-queue surface. Matches the frontend
// QueueMetrics interface with the time-series fields elided (they are
// computed elsewhere and surfaced separately when they exist).
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
