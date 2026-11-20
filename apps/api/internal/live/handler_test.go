package live

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
)

func TestNeedsResyncTable(t *testing.T) {
	cases := []struct {
		last    string
		current uint64
		want    bool
	}{
		{"", 0, true},
		{"", 5, true},
		{"nope", 1, true},
		{"3", 5, true},
		{"5", 5, false},
		{"9", 5, false},
	}
	for _, tc := range cases {
		if got := needsResync(tc.last, tc.current); got != tc.want {
			t.Fatalf("needsResync(%q,%d)=%v want %v", tc.last, tc.current, got, tc.want)
		}
	}
}

func TestEvents_Unauthorized(t *testing.T) {
	t.Parallel()
	hub := NewHub()
	authn := &auth.Authenticator{Store: auth.NewStore(nil)}
	app := fiber.New()
	Register(app, hub, authn)

	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d want 401", resp.StatusCode)
	}
}
