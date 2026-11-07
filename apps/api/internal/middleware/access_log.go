package middleware

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
)

// AccessLog wraps every request and emits one structured INFO line at completion.
// Long-lived SSE (/events) is skipped: live.sse.connect / live.sse.disconnect
// are the source of truth (ADR-0009).
func AccessLog() fiber.Handler {
	return func(c fiber.Ctx) error {
		start := time.Now()

		err := c.Next()

		if c.Path() == "/events" {
			return err
		}

		// c.Next has now run the handler chain; status is final.
		latencyMs := time.Since(start).Milliseconds()
		status := c.Response().StatusCode()
		level := slog.LevelInfo
		if status >= 500 {
			level = slog.LevelError
		} else if status >= 400 {
			level = slog.LevelWarn
		}

		attrs := []any{
			"event", "http.request",
			"method", c.Method(),
			"path", c.Path(),
			"status", status,
			"latencyMs", latencyMs,
			"requestId", RequestIDFromContext(c.Context()),
			"remoteIp", c.IP(),
			"bytesOut", len(c.Response().Body()),
		}
		if err != nil {
			// fiber's error handler will translate err into the response; we still want it in the access log so a 500 has its cause on the same line as its outcome.
			attrs = append(attrs, "err", err.Error())
		}

		slog.Log(c.Context(), level, "http.request", attrs...)
		return err
	}
}
