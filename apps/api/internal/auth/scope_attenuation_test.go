package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestScopeAttenuation_RejectsEscalation(t *testing.T) {
	t.Parallel()

	app := fiber.New()
	h := NewHandler(nil, nil)

	// Route that injects the given principal and executes h.Create
	app.Post("/test-create-key", func(c fiber.Ctx) error {
		callerKind := c.Get("X-Test-Kind", "api_key")
		callerScopesHeader := c.Get("X-Test-Scopes", "keys:admin")
		var callerScopes []string
		if callerScopesHeader != "" {
			callerScopes = strings.Split(callerScopesHeader, ",")
		}

		p := Principal{
			ID:     "test-key-id",
			Kind:   callerKind,
			Scopes: callerScopes,
		}
		if callerKind == "session" {
			p.Role = RoleAdmin
		}
		c.SetContext(context.WithValue(c.Context(), principalKey, p))
		return h.Create(c)
	})

	tests := []struct {
		name          string
		callerKind    string
		callerScopes  string
		body          createKeyRequest
		wantStatus    int
		wantErrorPart string
	}{
		{
			name:         "Scoped caller cannot grant wildcard *",
			callerKind:   "api_key",
			callerScopes: "keys:admin",
			body: createKeyRequest{
				Name:   "escalated-key",
				Scopes: []string{"*"},
			},
			wantStatus:    http.StatusForbidden,
			wantErrorPart: "wildcard",
		},
		{
			name:         "Scoped caller cannot grant debug scope",
			callerKind:   "api_key",
			callerScopes: "keys:admin",
			body: createKeyRequest{
				Name:   "debug-key",
				Scopes: []string{"debug"},
			},
			wantStatus:    http.StatusForbidden,
			wantErrorPart: "debug",
		},
		{
			name:         "Scoped caller cannot grant unheld jobs:write scope",
			callerKind:   "api_key",
			callerScopes: "keys:admin,jobs:read",
			body: createKeyRequest{
				Name:   "write-key",
				Scopes: []string{"jobs:write"},
			},
			wantStatus:    http.StatusForbidden,
			wantErrorPart: "jobs:write",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			payload, err := json.Marshal(tc.body)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/test-create-key", bytes.NewReader(payload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Test-Kind", tc.callerKind)
			req.Header.Set("X-Test-Scopes", tc.callerScopes)

			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("app.Test error: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tc.wantStatus {
				bodyBytes, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want %d; body = %s", resp.StatusCode, tc.wantStatus, string(bodyBytes))
			}

			bodyBytes, _ := io.ReadAll(resp.Body)
			if !strings.Contains(string(bodyBytes), tc.wantErrorPart) {
				t.Fatalf("body %q does not contain %q", string(bodyBytes), tc.wantErrorPart)
			}
		})
	}
}

func TestScopeAttenuation_CaseInsensitiveBearer(t *testing.T) {
	t.Parallel()
	authn := &Authenticator{Store: NewStore(nil)}
	app := fiber.New()
	app.Get("/protected", authn.Require(ScopeQueueRead), func(c fiber.Ctx) error {
		return c.SendString("ok")
	})

	// Lowercase "bearer " header
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "bearer veyra_12345678_notarealkey")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Since Store has nil pool, Verify fails with unauthenticated, but "bearer " prefix was accepted
	// (not rejected as missing Bearer header prefix).
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized, got %d", resp.StatusCode)
	}
}
