package middleware

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
)

// AccessLog wraps every request and emits one structured INFO line at
// completion with the operational fields an SRE actually needs: method, path,
// status, latency, request_id, remote ip, bytes out. We deliberately do NOT
// log the body — that's PII / payload data, the wrong default for a
// production access log.
//
// Mount AFTER RequestID so the log line carries the same id the response
// header carries. The order is the only coupling between the two.
//
// One INFO per request is a busy-but-acceptable cadence. The right knob for
// quieting it is the slog level (logging.Setup level=warn), not adding a
// "should-I-log-this-path" filter here.
func AccessLog() fiber.Handler {
	return func(c fiber.Ctx) error {
		start := time.Now()

		err := c.Next()

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
			// fiber's error handler will translate err into the response; we
			// still want it in the access log so a 500 has its cause on the
			// same line as its outcome.
			attrs = append(attrs, "err", err.Error())
		}

		slog.Log(c.Context(), level, "http.request", attrs...)
		return err
	}
}
