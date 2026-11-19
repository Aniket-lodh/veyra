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
		return KeyRecord{}, GeneratedKey{}, fmt.Errorf("auth.Create: name required")
	}
	scopes, err := ValidateScopes(scopes)
	if err != nil {
		return KeyRecord{}, GeneratedKey{}, err
	}
	if expiresAt != nil && !expiresAt.After(time.Now().UTC()) {
		return KeyRecord{}, GeneratedKey{}, fmt.Errorf("auth.Create: expiresAt must be in the future")
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
