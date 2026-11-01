// Package health owns the /health endpoint. It is its own package (rather
// than living in main or jobs) because liveness is a service-level concern
// independent of any particular domain — a future readiness probe, a future
// dependency-check endpoint, both belong here.
package health

import (
	"context"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler depends only on the pgx pool because the only liveness check that
// matters today is "can we reach Postgres?". Adding more dependencies as new
// probes are introduced is fine; resist adding mocks for them.
type Handler struct {
	pool *pgxpool.Pool
}

func NewHandler(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool}
}

// Register mounts the routes. Keeping route registration here (not in main)
// means cmd/api/main.go is wiring, not vocabulary.
func Register(app *fiber.App, h *Handler) {
	app.Get("/health", h.Health)
}

// Health responds 200 with a small JSON object when the database ping
// succeeds, 503 otherwise. It is deliberately a fresh connection check on
// every request — a stale pool that can't actually reach Postgres is exactly
// the "healthy" lie a probe must catch.
func (h *Handler) Health(c fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.Context(), pingTimeout)
	defer cancel()

	if err := h.pool.Ping(ctx); err != nil {
		slog.WarnContext(ctx, "health.check.db_ping_failed", "err", err.Error())
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"status":   "degraded",
			"database": "unreachable",
			"err":      err.Error(),
		})
	}

	return c.JSON(fiber.Map{
		"status":   "ok",
		"database": "connected",
	})
}

// pingTimeout keeps the probe responsive even when Postgres is wedged. A
// hung probe defeats its purpose — orchestrators expect a fast answer.
const pingTimeout = 2 * time.Second
