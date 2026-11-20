package health

import (
	"context"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	pool *pgxpool.Pool
}

func NewHandler(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool}
}

func Register(app *fiber.App, h *Handler) {
	app.Get("/health", h.Health)
}

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

const pingTimeout = 2 * time.Second
