package live

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/sse"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
)

const clientRetry = 3 * time.Second

// Register mounts GET /events (SSE invalidation stream).
func Register(app *fiber.App, hub *Hub, authn *auth.Authenticator) {
	app.Get("/events", authn.Require(auth.ScopeQueueRead), sse.New(sse.Config{
		Retry:             clientRetry,
		HeartbeatInterval: 15 * time.Second,
		OnClose: func(c fiber.Ctx, err error) {
			attrs := []any{
				"event", "live.sse.disconnect",
				"path", c.Path(),
				"subscribers", hub.SubscriberCount(),
				"revision", hub.Revision(),
			}
			if err != nil && !isCancel(err) {
				attrs = append(attrs, "err", err.Error())
			}
			slog.InfoContext(c.Context(), "live.sse.disconnect", attrs...)
		},
		Handler: func(c fiber.Ctx, stream *sse.Stream) error {
			return serveSSE(c, stream, hub)
		},
	}))
}

func serveSSE(c fiber.Ctx, stream *sse.Stream, hub *Hub) error {
	principal, _ := auth.PrincipalFromContext(c.Context())
	sub := hub.Subscribe()
	defer sub.Unsubscribe()

	slog.InfoContext(c.Context(), "live.sse.connect",
		"event", "live.sse.connect",
		"principalId", principal.ID,
		"kind", principal.Kind,
		"subscribers", hub.SubscriberCount(),
		"revision", hub.Revision(),
		"lastEventID", stream.LastEventID(),
	)

	if needsResync(stream.LastEventID(), hub.Revision()) {
		ev := hub.ResyncEvent()
		if err := writeFrame(stream, "resync", ev); err != nil {
			return err
		}
	}

	for {
		if ev, ok := sub.TakePending(); ok {
			if err := writeFrame(stream, "invalidate", ev); err != nil {
				return err
			}
			continue
		}
		select {
		case <-stream.Context().Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if err := writeFrame(stream, "invalidate", ev); err != nil {
				return err
			}
		}
	}
}

func writeFrame(stream *sse.Stream, name string, ev Event) error {
	return stream.Event(sse.Event{
		ID:   strconv.FormatUint(ev.Revision, 10),
		Name: name,
		Data: ev,
	})
}

// needsResync reports whether the client must receive a full resync frame.
// Exported for tests via the package-local name.
func needsResync(lastEventID string, current uint64) bool {
	if lastEventID == "" {
		return true
	}
	n, err := strconv.ParseUint(lastEventID, 10, 64)
	if err != nil {
		return true
	}
	return n < current
}

func isCancel(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
