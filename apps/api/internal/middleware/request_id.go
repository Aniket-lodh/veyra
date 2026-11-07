// Package middleware holds fiber middleware for the api.
package middleware

import (
	"context"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/oklog/ulid/v2"
)

// HeaderRequestID is the canonical request-id header.
const HeaderRequestID = "X-Request-Id"

// ctxKey is unexported so other packages cannot collide on the same key.
type ctxKey struct{ name string }

var requestIDKey = ctxKey{name: "request_id"}

// RequestID generates (or honours an inbound) request id, stashes it on the request context, and echoes it back on the response.
func RequestID() fiber.Handler {
	return func(c fiber.Ctx) error {
		rid := strings.TrimSpace(c.Get(HeaderRequestID))
		if rid == "" {
			rid = ulid.Make().String()
		}

		ctx := context.WithValue(c.Context(), requestIDKey, rid)
		c.SetContext(ctx)

		// Echo on the response so the caller sees what we used.
		c.Set(HeaderRequestID, rid)

		return c.Next()
	}
}

// RequestIDFromContext pulls the request id off ctx.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}
