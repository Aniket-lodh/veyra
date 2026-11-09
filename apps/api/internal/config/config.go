// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppEnv string
	Port   string

	DBHost     string
	DBPort     string
	DBUser     string
	DBPassword string
	DBName     string
	DBSSLMode  string

	// SweeperInterval is the cadence at which the stale-worker sweeper scans the workers table.
	SweeperInterval time.Duration

	// RetryInterval is the cadence at which the retry scheduler scans the jobs table for `failed` rows whose `next_retry_at <= now()`.
	RetryInterval time.Duration

	// RetryBatchLimit caps how many rows the scheduler promotes per tick.
	RetryBatchLimit int

	// ReclaimInterval is the cadence of the api-side reclaim tick driver.
	ReclaimInterval time.Duration

	// ReclaimBatchLimit caps how many expired-lease rows the reclaim driver processes per tick.
	ReclaimBatchLimit int
}

func Load() Config {
	return Config{
		AppEnv: getEnv("APP_ENV", "development"),
		Port:   getEnv("PORT", "8080"),

		DBHost:     getEnv("DB_HOST", "localhost"),
		DBPort:     getEnv("DB_PORT", "5432"),
		DBUser:     getEnv("DB_USER", "veyra"),
		DBPassword: getEnv("DB_PASSWORD", "veyra"),
		DBName:     getEnv("DB_NAME", "veyra"),
		DBSSLMode:  getEnv("DB_SSLMODE", "disable"),

		SweeperInterval:   getDurationSeconds("VEYRA_SWEEPER_INTERVAL_SECONDS", 10*time.Second),
		RetryInterval:     getDurationSeconds("VEYRA_RETRY_INTERVAL_SECONDS", 5*time.Second),
		RetryBatchLimit:   getInt("VEYRA_RETRY_BATCH_LIMIT", 256),
		ReclaimInterval:   getDurationSeconds("VEYRA_RECLAIM_INTERVAL_SECONDS", 10*time.Second),
		ReclaimBatchLimit: getInt("VEYRA_RECLAIM_BATCH_LIMIT", 100),
	}
}

// IsDevelopment reports whether the current AppEnv is one of the recognised dev/local values.
func (c Config) IsDevelopment() bool {
	switch strings.ToLower(strings.TrimSpace(c.AppEnv)) {
	case "", "dev", "development", "local":
		return true
	default:
		return false
	}
}

// DatabaseURL builds a libpq-compatible postgres:// URL from the configured credentials.
func (c Config) DatabaseURL() string {
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.DBUser, c.DBPassword),
		Host:   fmt.Sprintf("%s:%s", c.DBHost, c.DBPort),
		Path:   "/" + c.DBName,
	}
	q := u.Query()
	q.Set("sslmode", c.DBSSLMode)
	u.RawQuery = q.Encode()
	return u.String()
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)

	if value == "" {
		return fallback
	}

	return value
}

// getDurationSeconds parses an env var as a whole-second integer.
func getDurationSeconds(key string, fallback time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return fallback
	}
	return time.Duration(n) * time.Second
}

// getInt parses an env var as a positive integer.
func getInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return fallback
	}
	return n
}
