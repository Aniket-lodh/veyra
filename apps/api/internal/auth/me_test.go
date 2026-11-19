package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestMe_Unauthenticated(t *testing.T) {
	t.Parallel()
	h := NewSessionHandler(NewStore(nil), &Authenticator{Store: NewStore(nil)})
	app := fiber.New()
	app.Get("/auth/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestMe_SessionPrincipal(t *testing.T) {
	t.Parallel()
	h := NewSessionHandler(NewStore(nil), &Authenticator{Store: NewStore(nil)})
	app := fiber.New()
	app.Get("/auth/me", func(c fiber.Ctx) error {
		p := Principal{
			ID:     "user-123",
			Kind:   "session",
			Email:  "admin@example.com",
			Role:   RoleAdmin,
			Scopes: []string{ScopeAll},
		}
		c.SetContext(context.WithValue(c.Context(), principalKey, p))
		return h.Me(c)
	})

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// With nil pool, GetUser returns ErrUserNotFound -> 401 unauthorized ("session required")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on non-existent user, got %d", resp.StatusCode)
	}
}

func TestMe_APIKeyPrincipal(t *testing.T) {
	t.Parallel()
	h := NewSessionHandler(NewStore(nil), &Authenticator{Store: NewStore(nil)})
	app := fiber.New()
	app.Get("/auth/me", func(c fiber.Ctx) error {
		p := Principal{
			ID:     "key-123",
			Kind:   "api_key",
			Prefix: "veyra_abcd1234",
			Scopes: []string{ScopeJobsRead, ScopeJobsWrite},
		}
		c.SetContext(context.WithValue(c.Context(), principalKey, p))
		return h.Me(c)
	})

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// With nil pool, GetKeyByID returns ErrKeyNotFound -> 401 unauthorized ("api key not found")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on non-existent key, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "api key not found") {
		t.Fatalf("expected 'api key not found', got %s", string(body))
	}
}
