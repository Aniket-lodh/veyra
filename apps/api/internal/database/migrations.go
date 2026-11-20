// Package database owns the Postgres pool and migrations.
package database

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// migrationsSource is the file:// URL the migrate library reads SQL files from.
const migrationsSource = "file://migrations"

// RunMigrations applies every pending up migration against the database identified by databaseURL.
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
