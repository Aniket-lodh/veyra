package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
)

type SessionHandler struct {
	store *Store
	authn *Authenticator
}

func NewSessionHandler(store *Store, authn *Authenticator) *SessionHandler {
	return &SessionHandler{store: store, authn: authn}
}

func RegisterAuth(app *fiber.App, h *SessionHandler) {
	app.Get("/auth/status", h.Status)
	app.Post("/auth/signup", h.Signup)
	app.Post("/auth/login", h.Login)
	app.Post("/auth/logout", h.Logout)
	app.Get("/auth/me", h.authn.Require(), h.Me)
}

type credentialsBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *SessionHandler) Status(c fiber.Ctx) error {
	n, err := h.store.CountUsers(c.Context())
	if err != nil {
		slog.ErrorContext(c.Context(), "auth.status.count_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	out := fiber.Map{"bootstrapped": n > 0}
	if cookie := c.Cookies(SessionCookieName); cookie != "" {
		user, _, err := h.store.ResolveSession(c.Context(), cookie)
		if err == nil {
			out["user"] = user
		}
	}
	return c.JSON(out)
}

func (h *SessionHandler) Signup(c fiber.Ctx) error {
	n, err := h.store.CountUsers(c.Context())
	if err != nil {
		slog.ErrorContext(c.Context(), "auth.signup.count_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	if n > 0 {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error": "admin already exists; use login",
		})
	}

	var req credentialsBody
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid json body"})
	}

	user, err := h.store.CreateAdmin(c.Context(), req.Email, req.Password)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidEmail):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid email"})
		case errors.Is(err, ErrWeakPassword):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		case errors.Is(err, ErrEmailTaken):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "email already registered"})
		default:
			slog.ErrorContext(c.Context(), "auth.signup.failed", "err", err.Error())
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
		}
	}

	if err := h.issueSession(c, user.ID); err != nil {
		slog.ErrorContext(c.Context(), "auth.signup.session_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	slog.InfoContext(c.Context(), "auth.signup.ok",
		"userId", user.ID,
		"email", user.Email,
		"role", user.Role,
	)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"user": user})
}

func (h *SessionHandler) Login(c fiber.Ctx) error {
	var req credentialsBody
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid json body"})
	}

	user, err := h.store.AuthenticateUser(c.Context(), req.Email, req.Password)
	if err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid email or password"})
		}
		slog.ErrorContext(c.Context(), "auth.login.failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	if err := h.issueSession(c, user.ID); err != nil {
		slog.ErrorContext(c.Context(), "auth.login.session_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	slog.InfoContext(c.Context(), "auth.login.ok", "userId", user.ID, "email", user.Email)
	return c.JSON(fiber.Map{"user": user})
}

func (h *SessionHandler) Logout(c fiber.Ctx) error {
	if cookie := c.Cookies(SessionCookieName); cookie != "" {
		if err := h.store.RevokeSession(c.Context(), cookie); err != nil {
			slog.WarnContext(c.Context(), "auth.logout.revoke_failed", "err", err.Error())
		}
	}
	h.authn.ClearSessionCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *SessionHandler) Me(c fiber.Ctx) error {
	p, ok := PrincipalFromContext(c.Context())
	if !ok || p.Kind != "session" {
		return unauthorized(c, "session required")
	}
	user, err := h.store.GetUser(c.Context(), p.ID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return unauthorized(c, "session required")
		}
		slog.ErrorContext(c.Context(), "auth.me.failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"user": user})
}

func (h *SessionHandler) issueSession(c fiber.Ctx, userID string) error {
	token, expiresAt, err := h.store.CreateSession(c.Context(), userID)
	if err != nil {
		return err
	}
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = int(SessionTTL.Seconds())
	}
	h.authn.AttachSessionCookie(c, token, maxAge)
	return nil
}
