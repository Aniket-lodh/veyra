package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oklog/ulid/v2"
)

type Store struct {
	pool           *pgxpool.Pool
	lastUsedMinGap time.Duration
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{
		pool:           pool,
		lastUsedMinGap: 5 * time.Minute,
	}
}

func (s *Store) Verify(ctx context.Context, plaintext string) (Principal, error) {
	if s == nil || s.pool == nil {
		return Principal{}, ErrUnauthenticated
	}
	plaintext = strings.TrimSpace(plaintext)
	if plaintext == "" {
		return Principal{}, ErrUnauthenticated
	}
	prefix, err := ParsePrefix(plaintext)
	if err != nil {
		return Principal{}, ErrUnauthenticated
	}
	wantHash := HashKey(plaintext)

	const q = `
SELECT id, name, key_prefix, key_hash, scopes, expires_at, last_used_at
FROM api_keys
WHERE key_prefix = $1
  AND revoked_at IS NULL
LIMIT 1`
	var (
		id, name, keyPrefix, keyHash string
		scopes                       []string
		expiresAt, lastUsedAt        *time.Time
	)
	err = s.pool.QueryRow(ctx, q, prefix).Scan(
		&id, &name, &keyPrefix, &keyHash, &scopes, &expiresAt, &lastUsedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrUnauthenticated
	}
	if err != nil {
		return Principal{}, fmt.Errorf("auth.Verify: %w", err)
	}
	if !EqualHash(keyHash, wantHash) {
		return Principal{}, ErrUnauthenticated
	}
	if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
		return Principal{}, ErrUnauthenticated
	}

	s.touchLastUsed(ctx, id, lastUsedAt)
	return Principal{
		ID:     id,
		Kind:   "api_key",
		Prefix: keyPrefix,
		Scopes: scopes,
		Source: "db",
	}, nil
}

func (s *Store) touchLastUsed(ctx context.Context, id string, last *time.Time) {
	if last != nil && time.Since(*last) < s.lastUsedMinGap {
		return
	}
	go func() {
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_, err := s.pool.Exec(bg,
			`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND revoked_at IS NULL`,
			id,
		)
		if err != nil {
			slog.WarnContext(bg, "auth.last_used_update_failed",
				"keyId", id,
				"err", err.Error(),
			)
		}
	}()
}

func (s *Store) Create(ctx context.Context, name string, scopes []string, expiresAt *time.Time, createdByUserID string) (KeyRecord, GeneratedKey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return KeyRecord{}, GeneratedKey{}, ErrNameRequired
	}
	scopes, err := ValidateScopes(scopes)
	if err != nil {
		return KeyRecord{}, GeneratedKey{}, err
	}
	if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
		return KeyRecord{}, GeneratedKey{}, ErrExpiresAtPast
	}
	gen, err := GenerateKey()
	if err != nil {
		return KeyRecord{}, GeneratedKey{}, err
	}
	id := ulid.Make().String()
	gen.ID = id

	var createdBy *string
	if createdByUserID != "" {
		createdBy = &createdByUserID
	}

	const q = `
INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, expires_at, created_by_user_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)`
	_, err = s.pool.Exec(ctx, q, id, name, gen.Prefix, gen.Hash, scopes, expiresAt, createdBy)
	if err != nil {
		return KeyRecord{}, GeneratedKey{}, fmt.Errorf("auth.Create: %w", err)
	}
	return KeyRecord{
		ID:        id,
		Name:      name,
		Prefix:    gen.Prefix,
		Scopes:    scopes,
		Source:    "db",
		ExpiresAt: expiresAt,
	}, gen, nil
}

type ListedKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scopes     []string   `json:"scopes"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty"`
}

func (s *Store) List(ctx context.Context) ([]ListedKey, error) {
	const q = `
SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
FROM api_keys
ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("auth.List: %w", err)
	}
	defer rows.Close()

	out := make([]ListedKey, 0)
	for rows.Next() {
		var k ListedKey
		if err := rows.Scan(
			&k.ID, &k.Name, &k.Prefix, &k.Scopes,
			&k.CreatedAt, &k.LastUsedAt, &k.ExpiresAt, &k.RevokedAt,
		); err != nil {
			return nil, fmt.Errorf("auth.List: scan: %w", err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth.List: %w", err)
	}
	return out, nil
}

func (s *Store) Revoke(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("auth.Revoke: id required")
	}
	tag, err := s.pool.Exec(ctx, `
UPDATE api_keys
SET revoked_at = COALESCE(revoked_at, now())
WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("auth.Revoke: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrKeyNotFound
	}
	return nil
}

// GetKeyByID returns metadata for a single key by ID, without exposing secret hashes.
func (s *Store) GetKeyByID(ctx context.Context, id string) (ListedKey, error) {
	if s == nil || s.pool == nil {
		return ListedKey{}, ErrKeyNotFound
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return ListedKey{}, ErrKeyNotFound
	}
	const q = `
SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
FROM api_keys
WHERE id = $1`
	var k ListedKey
	err := s.pool.QueryRow(ctx, q, id).Scan(
		&k.ID, &k.Name, &k.Prefix, &k.Scopes,
		&k.CreatedAt, &k.LastUsedAt, &k.ExpiresAt, &k.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ListedKey{}, ErrKeyNotFound
	}
	if err != nil {
		return ListedKey{}, fmt.Errorf("auth.GetKeyByID: %w", err)
	}
	return k, nil
}

// ValidatePrincipal re-verifies that a principal is still active, unrevoked, unexpired, and holds queue:read scope.
func (s *Store) ValidatePrincipal(ctx context.Context, p Principal) error {
	if s == nil || s.pool == nil {
		return nil
	}
	switch p.Kind {
	case "api_key":
		const q = `
SELECT scopes, expires_at, revoked_at
FROM api_keys
WHERE id = $1`
		var (
			scopes    []string
			expiresAt *time.Time
			revokedAt *time.Time
		)
		err := s.pool.QueryRow(ctx, q, p.ID).Scan(&scopes, &expiresAt, &revokedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrKeyNotFound
		}
		if err != nil {
			return fmt.Errorf("auth.ValidatePrincipal: %w", err)
		}
		if revokedAt != nil {
			return ErrKeyRevoked
		}
		if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
			return ErrKeyExpired
		}
		hasQueueRead := false
		for _, sc := range scopes {
			if sc == ScopeAll || sc == ScopeQueueRead {
				hasQueueRead = true
				break
			}
		}
		if !hasQueueRead {
			return ErrForbidden
		}
		return nil

	case "session":
		if p.SessionID != "" {
			const q = `SELECT expires_at FROM sessions WHERE id = $1`
			var expiresAt time.Time
			err := s.pool.QueryRow(ctx, q, p.SessionID).Scan(&expiresAt)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrUnauthenticated
			}
			if err != nil {
				return fmt.Errorf("auth.ValidatePrincipal: %w", err)
			}
			if !expiresAt.After(time.Now().UTC()) {
				return ErrUnauthenticated
			}
		}
		if p.ID != "" {
			const q = `SELECT role FROM users WHERE id = $1`
			var role string
			err := s.pool.QueryRow(ctx, q, p.ID).Scan(&role)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrUserNotFound
			}
			if err != nil {
				return fmt.Errorf("auth.ValidatePrincipal: %w", err)
			}
		}
		return nil

	default:
		return ErrUnauthenticated
	}
}
