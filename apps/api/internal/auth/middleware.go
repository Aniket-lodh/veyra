package auth

import (
	"context"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v3"
)

type ctxKey struct{ name string }

var principalKey = ctxKey{name: "auth_principal"}

type Authenticator struct {
	Store         *Store
	SecureCookies bool
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	v, ok := ctx.Value(principalKey).(Principal)
	return v, ok
}

func ContextWithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

func (a *Authenticator) Require(scopes ...string) fiber.Handler {
	return func(c fiber.Ctx) error {
		if c.Query("api_key") != "" || c.Query("token") != "" || c.Query("access_token") != "" {
			slog.WarnContext(c.Context(), "auth.query_credential_rejected",
				"path", c.Path(),
			)
			return unauthorized(c, "credentials must use cookie or Authorization header")
		}

		principal, ok := PrincipalFromContext(c.Context())
		if !ok {
			var err error
			principal, err = a.resolve(c)
			if err != nil {
				slog.InfoContext(c.Context(), "auth.rejected",
					"path", c.Path(),
					"reason", "unauthenticated",
				)
				return unauthorized(c, "authentication required")
			}
		}

		if len(scopes) > 0 && !principal.HasAllScopes(scopes...) {
			slog.InfoContext(c.Context(), "auth.forbidden",
				"path", c.Path(),
				"principalId", principal.ID,
				"kind", principal.Kind,
				"required", scopes,
			)
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "insufficient scope",
			})
		}

		ctx := ContextWithPrincipal(c.Context(), principal)
		c.SetContext(ctx)
		return c.Next()
	}
}

func (a *Authenticator) resolve(c fiber.Ctx) (Principal, error) {
	if cookie := strings.TrimSpace(c.Cookies(SessionCookieName)); cookie != "" {
		user, sessionID, err := a.Store.ResolveSession(c.Context(), cookie)
		if err == nil {
			return Principal{
				ID:        user.ID,
				Kind:      "session",
				Email:     user.Email,
				Role:      user.Role,
				Scopes:    []string{ScopeAll},
				Source:    "session",
				SessionID: sessionID,
			}, nil
		}
		if err != ErrUnauthenticated {
			return Principal{}, err
		}
	}

	raw := c.Get("Authorization")
	if raw == "" {
		return Principal{}, ErrUnauthenticated
	}
	const prefix = "Bearer "
	if len(raw) < len(prefix) || !strings.EqualFold(raw[:len(prefix)], prefix) {
		return Principal{}, ErrUnauthenticated
	}
	token := strings.TrimSpace(raw[len(prefix):])
	if token == "" {
		return Principal{}, ErrUnauthenticated
	}
	return a.Store.Verify(c.Context(), token)
}

func (a *Authenticator) ValidatePrincipal(ctx context.Context, p Principal) error {
	if a == nil || a.Store == nil {
		return nil
	}
	return a.Store.ValidatePrincipal(ctx, p)
}

func unauthorized(c fiber.Ctx, msg string) error {
	c.Set("WWW-Authenticate", `Bearer realm="veyra"`)
	return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": msg})
}

func (a *Authenticator) AttachSessionCookie(c fiber.Ctx, token string, maxAgeSeconds int) {
	c.Cookie(&fiber.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAgeSeconds,
		HTTPOnly: true,
		Secure:   a.SecureCookies,
		SameSite: "Lax",
	})
}

func (a *Authenticator) ClearSessionCookie(c fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HTTPOnly: true,
		Secure:   a.SecureCookies,
		SameSite: "Lax",
	})
}
