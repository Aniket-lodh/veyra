package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/oklog/ulid/v2"
)

const (
	SessionTTL          = 30 * 24 * time.Hour
	SessionRenewIfUnder = 15 * 24 * time.Hour
	SessionCookieName   = "veyra_session"
)

func (s *Store) CreateSession(ctx context.Context, userID string) (token string, expiresAt time.Time, err error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", time.Time{}, fmt.Errorf("auth.CreateSession: rand: %w", err)
	}
	token = hex.EncodeToString(raw[:])
	hash := HashKey(token)
	id := ulid.Make().String()
	expiresAt = time.Now().UTC().Add(SessionTTL)

	const q = `
INSERT INTO sessions (id, user_id, token_hash, expires_at)
VALUES ($1, $2, $3, $4)`
	if _, err := s.pool.Exec(ctx, q, id, userID, hash, expiresAt); err != nil {
		return "", time.Time{}, fmt.Errorf("auth.CreateSession: %w", err)
	}
	return token, expiresAt, nil
}

func (s *Store) ResolveSession(ctx context.Context, token string) (User, string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return User{}, "", ErrUnauthenticated
	}
	hash := HashKey(token)
	const q = `
SELECT s.id, s.expires_at, u.id, u.email, u.role, u.created_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1`
	var (
		sessionID string
		expiresAt time.Time
		u         User
	)
	err := s.pool.QueryRow(ctx, q, hash).Scan(
		&sessionID, &expiresAt, &u.ID, &u.Email, &u.Role, &u.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrUnauthenticated
	}
	if err != nil {
		return User{}, "", fmt.Errorf("auth.ResolveSession: %w", err)
	}
	now := time.Now().UTC()
	if !expiresAt.After(now) {
		_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, sessionID)
		return User{}, "", ErrUnauthenticated
	}

	remaining := expiresAt.Sub(now)
	if remaining < SessionRenewIfUnder {
		newExp := now.Add(SessionTTL)
		_, err = s.pool.Exec(ctx, `
UPDATE sessions SET expires_at = $2, last_seen_at = $3 WHERE id = $1`,
			sessionID, newExp, now,
		)
		if err != nil {
			return User{}, "", fmt.Errorf("auth.ResolveSession: renew: %w", err)
		}
	} else {
		_, _ = s.pool.Exec(ctx, `
UPDATE sessions SET last_seen_at = $2 WHERE id = $1`, sessionID, now)
	}

	return u, sessionID, nil
}

func (s *Store) RevokeSession(ctx context.Context, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, HashKey(token))
	if err != nil {
		return fmt.Errorf("auth.RevokeSession: %w", err)
	}
	return nil
}

func (s *Store) RevokeAllUserSessions(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("auth.RevokeAllUserSessions: %w", err)
	}
	return nil
}
