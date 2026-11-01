// Package config loads the api service's runtime configuration from
// environment variables. It is the only place that reads os.Getenv; every
// other package takes a populated Config (or a single field off it) so the
// process has one well-known surface where env knobs are documented.
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

	// SweeperInterval is the cadence at which the stale-worker sweeper
	// scans the workers table. Each tick is a single UPDATE; tick
	// frequency does NOT need to be smaller than the worker heartbeat
	// interval — the threshold is `heartbeat * 3` per row, so a 10-second
	// sweep tick on a 5-second heartbeat sees stale workers within ~20s
	// in the worst case (5s + 5s + 5s threshold, then up to 10s until the
	// next tick). Configurable for the 24h soak harness.
	SweeperInterval time.Duration

	// RetryInterval is the cadence at which the retry scheduler scans the
	// jobs table for `failed` rows whose `next_retry_at <= now()`. See
	// SPEC.md §3.5.5 — promotion lag is bounded by this value. Default
	// 5 seconds.
	RetryInterval time.Duration

	// RetryBatchLimit caps how many rows the scheduler promotes per tick.
	// Bounds the worst-case write storm if the failure rate spikes (e.g.
	// a downstream just recovered). SPEC.md §3.5.3.
	RetryBatchLimit int

	// ReclaimInterval is the cadence of the api-side reclaim tick driver.
	// SPEC.md §5.10.2 — default 10s, MUST be lower than the lease
	// duration (30s) by a comfortable margin so an expired lease gets
	// reclaimed within ~1 lease duration in the worst case.
	ReclaimInterval time.Duration

	// ReclaimBatchLimit caps how many expired-lease rows the reclaim
	// driver processes per tick. SPEC.md §5.10.2 — bounds the per-tick
	// transaction. Larger backlogs drain across multiple ticks.
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

// IsDevelopment reports whether the current AppEnv is one of the recognised
// dev/local values. Used to gate developer-facing features (swagger UI,
// debug routes if we ever gate those) so they never ship in production
// containers. Mirrors the logging package's dev predicate.
func (c Config) IsDevelopment() bool {
	switch strings.ToLower(strings.TrimSpace(c.AppEnv)) {
	case "", "dev", "development", "local":
		return true
	default:
		return false
	}
}

// DatabaseURL builds a libpq-compatible postgres:// URL from the configured
// credentials. Used by golang-migrate (which speaks URLs, not the libpq DSN
// key=value form used by NewPostgresPool).
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

// getDurationSeconds parses an env var as a whole-second integer. Invalid
// or empty input returns the fallback, intentionally — the api keeps booting
// rather than refusing to start over a typo'd knob. Production deployments
// surface that via the env file, not by misconfiguring at runtime.
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

// getInt parses an env var as a positive integer. Same boot-friendly
// behavior as getDurationSeconds: bad input → fallback, no fatal.
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
