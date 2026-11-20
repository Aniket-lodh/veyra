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

	SweeperInterval      time.Duration
	RetryInterval        time.Duration
	RetryBatchLimit      int
	ReclaimInterval      time.Duration
	ReclaimBatchLimit    int
	CallbackInterval     time.Duration
	CallbackBatchLimit   int
	CallbackTimeout      time.Duration
	CallbackConcurrency  int
	CallbackSecret       string
	EnableDebugEndpoints bool
}

func Load() Config {
	c := Config{
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

		CallbackInterval:    getDurationSeconds("VEYRA_CALLBACK_INTERVAL_SECONDS", 2*time.Second),
		CallbackBatchLimit:  getInt("VEYRA_CALLBACK_BATCH_LIMIT", 50),
		CallbackTimeout:     getDurationSeconds("VEYRA_CALLBACK_TIMEOUT_SECONDS", 10*time.Second),
		CallbackConcurrency: getInt("VEYRA_CALLBACK_CONCURRENCY", 25),
		CallbackSecret:      getEnv("VEYRA_CALLBACK_SECRET", ""),
	}
	enableDebug := c.IsDevelopment()
	if raw := os.Getenv("ENABLE_DEBUG_ENDPOINTS"); raw != "" {
		enableDebug = parseBool(raw, enableDebug)
	}
	c.EnableDebugEndpoints = enableDebug
	return c
}

func (c Config) IsDevelopment() bool {
	switch strings.ToLower(strings.TrimSpace(c.AppEnv)) {
	case "", "dev", "development", "local":
		return true
	default:
		return false
	}
}

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

func parseBool(raw string, fallback bool) bool {
	v, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return v
}
