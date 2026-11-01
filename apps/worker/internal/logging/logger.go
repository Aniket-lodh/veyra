// Package logging is the worker service's structured-logger bootstrap.
//
// It is intentionally a near-copy of apps/api/internal/logging. We are
// allowing this ~30 lines of duplication on purpose — see the repo-root
// CLAUDE.md and the doc-comment on apps/api/internal/logging for the
// rationale. When (if) the two consumers diverge or a third appears, the
// shared piece moves to packages/logger.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// Setup builds the process-wide *slog.Logger and installs it as slog.Default.
// Call it exactly once at the top of main(), BEFORE any other code emits a
// log line.
//
// env: "" / "dev" / "development" / "local" → TextHandler; anything else →
// JSONHandler. Defaulting unknown values to JSON keeps production safe when
// the env var is missing.
//
// level: "debug" / "info" / "warn" / "error"; unknown → "info".
func Setup(env, level string) *slog.Logger {
	l := slog.New(buildHandler(os.Stderr, env, level))
	slog.SetDefault(l)
	return l
}

func buildHandler(w io.Writer, env, level string) slog.Handler {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}
	if isDev(env) {
		return slog.NewTextHandler(w, opts)
	}
	return slog.NewJSONHandler(w, opts)
}

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
