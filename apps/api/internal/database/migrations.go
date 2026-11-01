// Package database owns the Postgres connection pool and schema migration
// lifecycle for the api service.
package database

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// migrationsSource is the file:// URL the migrate library reads SQL files from.
// The path is resolved relative to the process working directory; the api
// binary is expected to run from apps/api/ so that "migrations/" resolves to
// apps/api/migrations/.
const migrationsSource = "file://migrations"

// RunMigrations applies every pending up migration against the database
// identified by databaseURL. It is a no-op when the database is already at
// the latest version (migrate.ErrNoChange is swallowed).
//
// The function opens its own database/sql connection through golang-migrate's
// postgres driver; it does not share a connection with the pgx pool. This is
// deliberate: migrations should run on a separate, short-lived connection so
// session-level state (advisory locks held by migrate, search_path, etc.) can
// never bleed into the application connection pool.
func RunMigrations(databaseURL string) (err error) {
	m, err := migrate.New(migrationsSource, databaseURL)
	if err != nil {
		return fmt.Errorf("database.RunMigrations: create migrate instance: %w", err)
	}

	defer func() {
		srcErr, dbErr := m.Close()
		if err != nil {
			return
		}
		switch {
		case srcErr != nil:
			err = fmt.Errorf("database.RunMigrations: close source: %w", srcErr)
		case dbErr != nil:
			err = fmt.Errorf("database.RunMigrations: close database: %w", dbErr)
		}
	}()

	if upErr := m.Up(); upErr != nil && !errors.Is(upErr, migrate.ErrNoChange) {
		return fmt.Errorf("database.RunMigrations: apply up: %w", upErr)
	}

	return nil
}
