package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v3"
)

type Handler struct {
	store *Store
	authn *Authenticator
}

func NewHandler(store *Store, authn *Authenticator) *Handler {
	return &Handler{store: store, authn: authn}
}

func Register(app *fiber.App, h *Handler) {
	app.Get("/api-keys", h.authn.Require(ScopeKeysAdmin), h.List)
	app.Post("/api-keys", h.authn.Require(ScopeKeysAdmin), h.Create)
	app.Delete("/api-keys/:id", h.authn.Require(ScopeKeysAdmin), h.Revoke)
}

type createKeyRequest struct {
	Name      string     `json:"name"`
	Scopes    []string   `json:"scopes"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

type createKeyResponse struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Prefix    string     `json:"prefix"`
	Scopes    []string   `json:"scopes"`
	ExpiresAt *time.Time `json:"expiresAt"`
	Secret    string     `json:"secret"`
}

func (h *Handler) List(c fiber.Ctx) error {
	keys, err := h.store.List(c.Context())
	if err != nil {
		slog.ErrorContext(c.Context(), "auth.keys.list_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"keys": keys})
}

func (h *Handler) Create(c fiber.Ctx) error {
	var req createKeyRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid json body"})
	}
	scopes := req.Scopes
	if len(scopes) == 0 {
		scopes = []string{ScopeAll}
	}

	createdBy := ""
	if p, ok := PrincipalFromContext(c.Context()); ok && p.Kind == "session" {
		createdBy = p.ID
	}

	rec, gen, err := h.store.Create(c.Context(), req.Name, scopes, req.ExpiresAt, createdBy)
	if err != nil {
		if errors.Is(err, ErrInvalidScope) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		if err.Error() == "auth.Create: name required" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name is required"})
		}
		if err.Error() == "auth.Create: expiresAt must be in the future" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "expiresAt must be in the future"})
		}
		slog.ErrorContext(c.Context(), "auth.keys.create_failed", "err", err.Error())
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	principal, _ := PrincipalFromContext(c.Context())
	slog.InfoContext(c.Context(), "auth.keys.created",
		"keyId", rec.ID,
		"keyPrefix", rec.Prefix,
		"name", rec.Name,
		"scopes", rec.Scopes,
		"createdBy", principal.ID,
	)
	return c.Status(fiber.StatusCreated).JSON(createKeyResponse{
		ID:        rec.ID,
		Name:      rec.Name,
		Prefix:    rec.Prefix,
		Scopes:    rec.Scopes,
		ExpiresAt: rec.ExpiresAt,
		Secret:    gen.Secret,
	})
}

func (h *Handler) Revoke(c fiber.Ctx) error {
	id := c.Params("id")
	if err := h.store.Revoke(c.Context(), id); err != nil {
		if errors.Is(err, ErrKeyNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "api key not found"})
		}
		slog.ErrorContext(c.Context(), "auth.keys.revoke_failed", "err", err.Error(), "keyId", id)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	principal, _ := PrincipalFromContext(c.Context())
	slog.InfoContext(c.Context(), "auth.keys.revoked",
		"keyId", id,
		"revokedBy", principal.ID,
	)
	return c.SendStatus(fiber.StatusNoContent)
}
