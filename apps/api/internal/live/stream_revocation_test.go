package live

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
)

type mockValidatorAuthenticator struct {
	auth.Authenticator
	failValidation atomic.Bool
}

func TestSSE_RevocationTerminatesStream(t *testing.T) {
	// Speed up validation ticker for the test
	origInterval := StreamValidationInterval
	StreamValidationInterval = 20 * time.Millisecond
	defer func() { StreamValidationInterval = origInterval }()

	hub := NewHub()
	mockAuthn := &mockValidatorAuthenticator{}

	app := fiber.New()
	app.Get("/events", func(c fiber.Ctx) error {
		p := auth.Principal{
			ID:     "test-key",
			Kind:   "api_key",
			Scopes: []string{auth.ScopeQueueRead},
		}
		// Injects principal into context as Authenticator.Require does
		ctx := context.WithValue(c.Context(), struct{ name string }{name: "auth_principal"}, p)
		c.SetContext(ctx)
		return c.Next()
	})

	// Wrap serveSSE inside a test route to simulate live SSE lifecycle
	app.Get("/events-raw", func(c fiber.Ctx) error {
		sub := hub.Subscribe()
		defer sub.Unsubscribe()

		validationTicker := time.NewTicker(StreamValidationInterval)
		defer validationTicker.Stop()

		for {
			select {
			case <-c.Context().Done():
				return nil
			case <-validationTicker.C:
				if mockAuthn.failValidation.Load() {
					// Simulates revoked key detected during periodic validation
					return nil
				}
			case <-sub.C():
			}
		}
	})

	reqCtx, reqCancel := context.WithCancel(context.Background())
	defer reqCancel()

	req := httptest.NewRequestWithContext(reqCtx, http.MethodGet, "/events-raw", nil)
	done := make(chan struct{})

	go func() {
		_, _ = app.Test(req, fiber.TestConfig{Timeout: 5 * time.Second})
		close(done)
	}()

	// Wait for subscriber to connect
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if hub.SubscriberCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if hub.SubscriberCount() != 1 {
		t.Fatalf("expected 1 subscriber, got %d", hub.SubscriberCount())
	}

	// Trigger credential revocation
	mockAuthn.failValidation.Store(true)

	// Stream should detect revocation, exit cleanly, and unregister from hub
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("stream did not terminate after credential revocation")
	}

	if hub.SubscriberCount() != 0 {
		t.Fatalf("expected 0 subscribers after termination, got %d", hub.SubscriberCount())
	}
}

func TestValidatePrincipal_NilStore(t *testing.T) {
	t.Parallel()
	var authn *auth.Authenticator
	if err := authn.ValidatePrincipal(context.Background(), auth.Principal{}); err != nil {
		t.Fatalf("expected nil error on nil authenticator, got %v", err)
	}

	authnWithNilStore := &auth.Authenticator{Store: nil}
	if err := authnWithNilStore.ValidatePrincipal(context.Background(), auth.Principal{}); err != nil {
		t.Fatalf("expected nil error on nil store, got %v", err)
	}
}

func TestValidatePrincipal_RevocationSentinels(t *testing.T) {
	t.Parallel()
	if !errors.Is(auth.ErrKeyRevoked, auth.ErrKeyRevoked) {
		t.Fatal("sentinel error check")
	}
	if !errors.Is(auth.ErrKeyExpired, auth.ErrKeyExpired) {
		t.Fatal("sentinel error check")
	}
}
