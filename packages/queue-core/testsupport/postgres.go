//go:build integration

// Package testsupport is shared harness code for queue-core integration tests.
package testsupport

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// StartPostgres boots an ephemeral Postgres container, applies the apps/api migrations against it, and returns a connection pool ready to use.
func StartPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pgContainer, err := postgres.Run(ctx,
		"postgres:16-alpine",
		postgres.WithDatabase("veyra"),
		postgres.WithUsername("veyra"),
		postgres.WithPassword("veyra"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("testsupport.StartPostgres: container start: %v", err)
	}
	t.Cleanup(func() {
		// Termination ignores errors; the container is ephemeral, and a failure to terminate is a Docker-daemon problem the test cannot usefully act on.
		_ = pgContainer.Terminate(context.Background())
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("testsupport.StartPostgres: connection string: %v", err)
	}

	if err := applyMigrations(connStr); err != nil {
		t.Fatalf("testsupport.StartPostgres: migrate: %v", err)
	}

	cfg, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		t.Fatalf("testsupport.StartPostgres: parse config: %v", err)
	}
	cfg.MaxConns = 16

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("testsupport.StartPostgres: pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("testsupport.StartPostgres: ping: %v", err)
	}
	return pool
}

// applyMigrations runs the apps/api/migrations directory against the container.
func applyMigrations(connStr string) error {
	migrationsURL, err := migrationsFileURL()
	if err != nil {
		return err
	}
	m, err := migrate.New(migrationsURL, connStr)
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	defer func() {
		// migrate.Close returns two errors; both are best-effort on shutdown.
		_, _ = m.Close()
	}()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate.Up: %w", err)
	}
	return nil
}

// migrationsFileURL returns a `file://` URL pointing at apps/api/migrations, resolved relative to this source file.
func migrationsFileURL() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	// thisFile = <repo>/packages/queue-core/testsupport/postgres.go repoRoot = <repo>
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", ".."))
	migrationsDir := filepath.Join(repoRoot, "apps", "api", "migrations")
	return "file://" + migrationsDir, nil
}
