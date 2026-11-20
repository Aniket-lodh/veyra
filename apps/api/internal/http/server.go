package http

import (
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/middleware"
)

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
	msg := err.Error()
	if code >= fiber.StatusInternalServerError {
		msg = "internal server error"
	}
	return c.Status(code).JSON(fiber.Map{"error": msg})
}
