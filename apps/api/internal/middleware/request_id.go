package middleware

import (
	"context"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/oklog/ulid/v2"
)

const HeaderRequestID = "X-Request-Id"

type ctxKey struct{ name string }

var requestIDKey = ctxKey{name: "request_id"}

func RequestID() fiber.Handler {
	return func(c fiber.Ctx) error {
		rid := strings.TrimSpace(c.Get(HeaderRequestID))
		if rid == "" {
			rid = ulid.Make().String()
		}

		ctx := context.WithValue(c.Context(), requestIDKey, rid)
		c.SetContext(ctx)

		c.Set(HeaderRequestID, rid)

		return c.Next()
	}
}

func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}
