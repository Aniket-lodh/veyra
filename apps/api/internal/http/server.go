// Package http owns the construction of the fiber.App: the App config, the
// central error handler, and the global middleware chain. Per-domain routes
// (jobs, health, debug, …) are mounted by their own Register functions from
// cmd/api/main.go — this package does NOT know what routes exist. That
// separation keeps the HTTP layer's concerns (server config, middleware,
// error mapping) decoupled from the service's domain vocabulary.
package http

import (
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/middleware"
)

// NewApp builds the fiber.App with the standard middleware chain mounted but
// no domain routes registered. Callers (cmd/api/main.go) attach health/jobs/
// debug routes via their respective Register functions after this returns.
//
// The middleware chain is intentional and order-sensitive:
//
//  1. RequestID — generates/honours the correlation id, sets it on the
//     request context. Must come first so every later middleware (and every
//     handler log) can read it from ctx.
//  2. AccessLog — wraps the handler chain, emits one structured INFO line
//     per request with method/path/status/latency/requestId.
//
// Anything that needs the request id must be mounted after RequestID.
// Anything that wants to be measured by AccessLog must be mounted after
// AccessLog. Both are true by default for everything else in this app.
func NewApp(appName string) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:       appName,
		CaseSensitive: true,
		StrictRouting: true,
		ErrorHandler:  errorHandler,
	})

	app.Use(middleware.RequestID())
	app.Use(middleware.AccessLog())

	return app
}

// errorHandler is fiber's default error sink. It maps known sentinel types
// (currently only fiber.Error) to their status code and emits a JSON body
// the frontend can parse uniformly. Domain-specific errors should be mapped
// inside their handler — this is the last line of defence, not the first.
//
// The log here is at error level on purpose: any error reaching this point
// was not handled by the route, which an operator usually wants to see.
func errorHandler(c fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	var fe *fiber.Error
	if errors.As(err, &fe) {
		code = fe.Code
	}
	slog.ErrorContext(c.Context(), "http.unhandled_error",
		"method", c.Method(),
		"path", c.Path(),
		"status", code,
		"err", err.Error(),
	)
	return c.Status(code).JSON(fiber.Map{"error": err.Error()})
}
