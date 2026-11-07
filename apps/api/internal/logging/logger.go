// Package logging bootstraps the process slog.Logger.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// Setup builds the process-wide *slog.Logger and installs it as slog.Default.
func Setup(env, level string) *slog.Logger {
	l := slog.New(buildHandler(os.Stderr, env, level))
	slog.SetDefault(l)
	return l
}

// buildHandler is the only place that knows which slog.Handler to use.
func buildHandler(w io.Writer, env, level string) slog.Handler {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}
	if isDev(env) {
		return slog.NewTextHandler(w, opts)
	}
	return slog.NewJSONHandler(w, opts)
}

// isDev decides whether the environment string indicates a local/development run.
func isDev(env string) bool {
	switch strings.ToLower(strings.TrimSpace(env)) {
	case "", "dev", "development", "local":
		return true
	default:
		return false
	}
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
