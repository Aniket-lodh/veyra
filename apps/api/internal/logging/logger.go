// Package logging is the api service's structured-logger bootstrap. It owns
// exactly one decision: how the *slog.Logger that every other package will
// reach via slog.Default() is constructed. Nothing in here wraps slog; nothing
// in here defines a Logger interface. Other packages call slog.Info/.Error/...
// directly with structured fields — see slog stdlib docs.
//
// Why no wrapper:
//   - slog is the stdlib. An indirection layer adds zero value and one more
//     thing to maintain.
//   - Tests can swap the default with slog.SetDefault(...) without us
//     inventing a seam.
//   - Future destinations (OTel, Loki, …) attach as slog.Handler
//     implementations, not as a new Logger type.
//
// Why per-service (not packages/logger):
//   - The duplication today is a ~30 line Setup function, dominated by env
//     parsing. Promoting it to a shared package now would be premature; we
//     promote only when behaviour actually diverges or a third consumer
//     appears. See the repo-root CLAUDE.md.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// Setup builds the process-wide *slog.Logger and installs it as slog.Default.
// Call it exactly once at the top of main(), BEFORE any other code emits a
// log line — early ad-hoc log.Println calls bypass this and are exactly the
// problem this package exists to remove.
//
// env decides the handler:
//   - "" / "dev" / "development" / "local" → TextHandler (human-readable)
//   - anything else (production, staging, …) → JSONHandler (machine-parseable)
//
// level is the minimum visible level ("debug" / "info" / "warn" / "error").
// Unrecognised values default to info — startup should be visible by default.
//
// The returned *slog.Logger is the same instance installed as slog.Default(),
// returned so callers that want to pass it explicitly (a middleware ctor, a
// background worker) can do so without re-reading slog.Default().
func Setup(env, level string) *slog.Logger {
	l := slog.New(buildHandler(os.Stderr, env, level))
	slog.SetDefault(l)
	return l
}

// buildHandler is the only place that knows which slog.Handler to use. Keep
// it private — callers should not be choosing handlers ad hoc.
func buildHandler(w io.Writer, env, level string) slog.Handler {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}
	if isDev(env) {
		return slog.NewTextHandler(w, opts)
	}
	return slog.NewJSONHandler(w, opts)
}

// isDev decides whether the environment string indicates a local/development
// run. Anything we don't recognise as dev is treated as production — fail
// safely toward machine-parseable JSON when the env var is misconfigured.
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
