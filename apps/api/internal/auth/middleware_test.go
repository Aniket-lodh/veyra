package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestRequire_MissingAuth(t *testing.T) {
	t.Parallel()
	authn := &Authenticator{Store: NewStore(nil)}
	app := fiber.New()
	app.Get("/jobs", authn.Require(ScopeJobsRead), func(c fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/jobs", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestRequire_QueryCredentialRejected(t *testing.T) {
	t.Parallel()
	authn := &Authenticator{Store: NewStore(nil)}
	app := fiber.New()
	app.Get("/jobs", authn.Require(ScopeJobsRead), func(c fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest(http.MethodGet, "/jobs?api_key=x", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("query credential should be rejected, got %d", resp.StatusCode)
	}
}

func TestRequireAny_Scopes(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	authn := &Authenticator{Store: NewStore(nil)}

	app.Get("/worker-endpoint", func(c fiber.Ctx) error {
		// Simulate auth context injection
		switch c.Get("X-Test-Role") {
		case "workers_write":
			c.SetContext(ContextWithPrincipal(c.Context(), Principal{
				ID:     "key1",
				Kind:   "api_key",
				Scopes: []string{ScopeWorkersWrite},
			}))
		case "jobs_write":
			c.SetContext(ContextWithPrincipal(c.Context(), Principal{
				ID:     "key2",
				Kind:   "api_key",
				Scopes: []string{ScopeJobsWrite},
			}))
		case "queue_read":
			c.SetContext(ContextWithPrincipal(c.Context(), Principal{
				ID:     "key3",
				Kind:   "api_key",
				Scopes: []string{ScopeQueueRead},
			}))
		}
		return c.Next()
	}, authn.RequireAny(ScopeWorkersWrite, ScopeJobsWrite), func(c fiber.Ctx) error {
		return c.SendString("authorized")
	})

	// Case 1: Has ScopeWorkersWrite -> 200
	req1 := httptest.NewRequest(http.MethodGet, "/worker-endpoint", nil)
	req1.Header.Set("X-Test-Role", "workers_write")
	resp1, err := app.Test(req1)
	if err != nil {
		t.Fatal(err)
	}
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for workers:write, got %d", resp1.StatusCode)
	}

	// Case 2: Has ScopeJobsWrite -> 200
	req2 := httptest.NewRequest(http.MethodGet, "/worker-endpoint", nil)
	req2.Header.Set("X-Test-Role", "jobs_write")
	resp2, err := app.Test(req2)
	if err != nil {
		t.Fatal(err)
	}
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for jobs:write, got %d", resp2.StatusCode)
	}

	// Case 3: Has ScopeQueueRead (missing both) -> 403 Forbidden
	req3 := httptest.NewRequest(http.MethodGet, "/worker-endpoint", nil)
	req3.Header.Set("X-Test-Role", "queue_read")
	resp3, err := app.Test(req3)
	if err != nil {
		t.Fatal(err)
	}
	if resp3.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for queue:read, got %d", resp3.StatusCode)
	}
}
