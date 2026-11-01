// Package middleware holds the api service's fiber-v3 middleware. Each file
// is one concern, and each concern attaches data to the REQUEST CONTEXT
// (c.SetContext) — not c.Locals — so downstream service and repository code
// that takes context.Context can read it without importing fiber. See
// apps/api/CLAUDE.md "No c.Locals for request-scoped data that crosses
// package boundaries."
package middleware

import (
	"context"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/oklog/ulid/v2"
)

// HeaderRequestID is the canonical request-id header. We accept it on input
// (honour the caller's correlation id if they sent one) and echo it on every
// response so the caller can correlate their client log line with our server
// log line.
const HeaderRequestID = "X-Request-Id"

// ctxKey is unexported so other packages cannot collide on the same key. The
// public API is RequestIDFromContext.
type ctxKey struct{ name string }

var requestIDKey = ctxKey{name: "request_id"}

// RequestID generates (or honours an inbound) request id, stashes it on the
// request context, and echoes it back on the response. Every per-request log
// line should carry it — that's what makes a tail of JSON logs from N
// concurrent requests separable into per-request narratives.
//
// Why ULID and not UUID v4:
//   - Lexicographic sort matches insertion order, which is the order an
//     operator reads logs.
//   - Same id family the queue uses for jobs and worker runtimes, so
//     correlation across the system is one greppable token.
func RequestID() fiber.Handler {
	return func(c fiber.Ctx) error {
		rid := strings.TrimSpace(c.Get(HeaderRequestID))
		if rid == "" {
			rid = ulid.Make().String()
		}

		ctx := context.WithValue(c.Context(), requestIDKey, rid)
		c.SetContext(ctx)

		// Echo on the response so the caller sees what we used. Set BEFORE
		// c.Next so it's present even on handler errors.
		c.Set(HeaderRequestID, rid)

		return c.Next()
	}
}

// RequestIDFromContext pulls the request id off ctx. Returns "" when there
// isn't one — callers may emit a log line with an empty rid (out-of-request
// background work) without us inventing a fake id.
func RequestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}
