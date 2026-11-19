package auth

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/oklog/ulid/v2"
)

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*)::int FROM users`).Scan(&n); err != nil {
		return 0, fmt.Errorf("auth.CountUsers: %w", err)
	}
	return n, nil
}

func NormalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", ErrInvalidEmail
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return "", ErrInvalidEmail
	}
	return email, nil
}

func (s *Store) CreateAdmin(ctx context.Context, email, password string) (User, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return User{}, err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	id := ulid.Make().String()
	const q = `
INSERT INTO users (id, email, password_hash, role)
VALUES ($1, $2, $3, $4)
RETURNING created_at`
	var createdAt time.Time
	err = s.pool.QueryRow(ctx, q, id, email, hash, RoleAdmin).Scan(&createdAt)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("auth.CreateAdmin: %w", err)
	}
	return User{ID: id, Email: email, Role: RoleAdmin, CreatedAt: createdAt}, nil
}

func (s *Store) AuthenticateUser(ctx context.Context, email, password string) (User, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return User{}, ErrInvalidCredentials
	}
	const q = `
SELECT id, email, password_hash, role, created_at
FROM users WHERE email = $1`
	var (
		u    User
		hash string
	)
	err = s.pool.QueryRow(ctx, q, email).Scan(&u.ID, &u.Email, &hash, &u.Role, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("auth.AuthenticateUser: %w", err)
	}
	if !CheckPassword(hash, password) {
		return User{}, ErrInvalidCredentials
	}
	return u, nil
}

func (s *Store) GetUser(ctx context.Context, id string) (User, error) {
	const q = `SELECT id, email, role, created_at FROM users WHERE id = $1`
	var u User
	err := s.pool.QueryRow(ctx, q, id).Scan(&u.ID, &u.Email, &u.Role, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("auth.GetUser: %w", err)
	}
	return u, nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "users_email_uidx")
}
