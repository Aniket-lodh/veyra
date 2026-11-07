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
