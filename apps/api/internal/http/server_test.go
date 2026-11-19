package http

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestErrorHandler_Sanitizes500(t *testing.T) {
	t.Parallel()
	app := NewApp("test-app")

	app.Get("/crash", func(c fiber.Ctx) error {
		return errors.New("pgx: fatal database connection lost at 10.0.0.1:5432; table 'jobs_secret' syntax error")
	})

	req := httptest.NewRequest(http.MethodGet, "/crash", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	bodyStr := string(body)

	// Must contain generic message
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected generic 'internal server error', got %s", bodyStr)
	}

	// Must NOT leak database details
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "jobs_secret") || strings.Contains(bodyStr, "10.0.0.1") {
		t.Fatalf("raw error leaked in 500 response: %s", bodyStr)
	}
}

func TestErrorHandler_Preserves4xx(t *testing.T) {
	t.Parallel()
	app := NewApp("test-app")

	app.Get("/bad", func(c fiber.Ctx) error {
		return fiber.NewError(fiber.StatusBadRequest, "custom bad request message")
	})

	req := httptest.NewRequest(http.MethodGet, "/bad", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	bodyStr := string(body)

	if !strings.Contains(bodyStr, `"error":"custom bad request message"`) {
		t.Fatalf("expected preserved 400 message, got %s", bodyStr)
	}
}
