// Veyra API. Wires the process: load env → bootstrap logger → connect DB →
// run migrations → build the fiber app → register per-domain routes →
// Listen with signal-aware graceful shutdown. Everything that is not wiring
// lives in internal/<domain>/.
//
// Shutdown contract: on SIGINT or SIGTERM, stop accepting new connections,
// give in-flight requests up to shutdownTimeout to finish, then close the
// db pool. Containers WILL restart; this code is the contract that lets
// `docker stop` complete in seconds rather than hanging until SIGKILL.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/contrib/v3/swaggerui"
	"github.com/joho/godotenv"

	"github.com/Aniket-lodh/veyra/api/internal/config"
	"github.com/Aniket-lodh/veyra/api/internal/database"
	"github.com/Aniket-lodh/veyra/api/internal/debug"
	"github.com/Aniket-lodh/veyra/api/internal/health"
	apihttp "github.com/Aniket-lodh/veyra/api/internal/http"
	"github.com/Aniket-lodh/veyra/api/internal/jobs"
	"github.com/Aniket-lodh/veyra/api/internal/logging"
	"github.com/Aniket-lodh/veyra/api/internal/reclaim"
	"github.com/Aniket-lodh/veyra/api/internal/retries"
	"github.com/Aniket-lodh/veyra/api/internal/stats"
	"github.com/Aniket-lodh/veyra/api/internal/workers"
	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

const (
	serviceName     = "veyra-api"
	dbPingLimit     = 5 * time.Second
	shutdownTimeout = 15 * time.Second
)

func main() {
	// .env first, BEFORE Setup, because the env values configure the logger.
	envMissing := godotenv.Load() != nil

	cfg := config.Load()

	logger := logging.Setup(cfg.AppEnv, os.Getenv("LOG_LEVEL"))
	logger.Info("service.starting",
		"service", serviceName,
		"env", cfg.AppEnv,
		"port", cfg.Port,
		"envFileMissing", envMissing,
	)

	// Signal-aware root context. Cancelled on the first SIGINT / SIGTERM.
	// In containers, `docker stop` sends SIGTERM (default 10s grace before
	// SIGKILL); the prod compose bumps grace where needed.
	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbPool, err := database.NewPostgresPool(cfg)
	if err != nil {
		exitFatal("service.db.connect_failed", err)
	}
	defer dbPool.Close()

	if err := database.RunMigrations(cfg.DatabaseURL()); err != nil {
		exitFatal("service.db.migrate_failed", err)
	}
	slog.Info("service.db.migrations_applied")

	pingCtx, pingCancel := context.WithTimeout(rootCtx, dbPingLimit)
	if err := dbPool.Ping(pingCtx); err != nil {
		pingCancel()
		exitFatal("service.db.ping_failed", err)
	}
	pingCancel()
	slog.Info("service.db.ping_ok")

	app := apihttp.NewApp(serviceName)

	// Swagger is a developer-facing UI, not a product feature. It is mounted
	// only in development environments — production images include the
	// docs/ directory in case an operator flips APP_ENV briefly, but the
	// endpoint must not be live by default.
	if cfg.IsDevelopment() {
		app.Use(swaggerui.New(swaggerui.Config{
			BasePath: "/",
			FilePath: "./docs/swagger.json",
			Path:     "swagger",
			Title:    "Swagger API Docs",
		}))
		slog.Info("service.swagger.mounted", "path", "/swagger")
	}

	jobRepo := queuecore.NewRepository(dbPool)

	health.Register(app, health.NewHandler(dbPool))
	jobs.Register(app, jobs.NewHandler(jobRepo))
	stats.Register(app, stats.NewHandler(jobRepo))
	workers.Register(app, workers.NewHandler(dbPool, jobRepo))
	debug.Register(app, debug.NewHandler(jobRepo))

	// Stale-worker sweeper. Background goroutine that ticks every
	// SweeperInterval, marking heartbeat-silent workers as 'disconnected'.
	// Writes ONLY workers.state — queue-state transitions live elsewhere:
	// reclaim is the queue-core primitive (SPEC §5), invoked inline by
	// Dequeue AND by the api-side reclaim driver (below). See
	// internal/workers/sweeper.go header for the sweeper/reclaim split.
	sweeper := workers.NewSweeper(dbPool, cfg.SweeperInterval)
	go func() {
		if err := sweeper.Run(rootCtx); err != nil {
			slog.Error("service.sweeper.failed", "err", err.Error())
		}
	}()

	// Retry scheduler. Background goroutine that promotes retry-due
	// `failed` rows back to `queued`. SPEC.md §3.5.3 + ADR-0006.
	// Like the sweeper, it writes only its own narrow column set —
	// `next_retry_at` is computed by Nack, not here.
	retryScheduler := retries.NewScheduler(dbPool, cfg.RetryInterval, cfg.RetryBatchLimit)
	go func() {
		if err := retryScheduler.Run(rootCtx); err != nil {
			slog.Error("service.retry_scheduler.failed", "err", err.Error())
		}
	}()

	// Reclaim driver. Background goroutine that scans expired-lease
	// `running` rows (with the §5.10.1 grace window applied) and invokes
	// the queue-core Reclaim primitive on each one with mode=TickRequeue.
	// This is the SECOND invocation site of reclaim; the FIRST is inline
	// inside Dequeue. Both call the same primitive — never duplicate the
	// transition logic. SPEC.md §5.10.2 + the
	// `feedback-shared-semantics-shared-primitive` memory.
	reclaimDriver := reclaim.NewDriver(dbPool, cfg.ReclaimInterval, cfg.ReclaimBatchLimit)
	go func() {
		if err := reclaimDriver.Run(rootCtx); err != nil {
			slog.Error("service.reclaim_driver.failed", "err", err.Error())
		}
	}()

	addr := fmt.Sprintf(":%s", cfg.Port)

	// Listen on a goroutine so the main goroutine can wait on signals AND
	// the listener error in a single select. fiber.Listen blocks until the
	// listener stops; the only way out is Shutdown or a fatal listener err.
	listenErr := make(chan error, 1)
	go func() {
		slog.Info("service.http.listening", "addr", addr, "service", serviceName)
		listenErr <- app.Listen(addr)
	}()

	select {
	case err := <-listenErr:
		// http.ErrServerClosed is the canonical "we asked it to stop" return
		// from fiber/fasthttp shutdown — distinguish from a true listener
		// failure (port already bound, etc.).
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			exitFatal("service.http.listen_failed", err)
		}
	case <-rootCtx.Done():
		slog.Info("service.stopping",
			"service", serviceName,
			"reason", "signal",
			"shutdownTimeoutSeconds", int(shutdownTimeout/time.Second),
		)
	}

	// Graceful shutdown. The fresh context is intentional: rootCtx is already
	// done at this point, and Shutdown needs a live deadline. After the
	// deadline, in-flight handlers are abandoned (the caller sees a closed
	// connection) — that's the cost of being a good container citizen.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := app.ShutdownWithContext(shutdownCtx); err != nil {
		slog.Error("service.shutdown.failed",
			"service", serviceName,
			"err", err.Error(),
		)
	} else {
		slog.Info("service.shutdown.complete", "service", serviceName)
	}
	// The defer above closes dbPool. Pool close drains active queries; any
	// query mid-flight in an abandoned handler will see context.Canceled.
}

// exitFatal emits one structured ERROR line and exits 1. Used for startup
// failures where we cannot meaningfully continue. We do not use log.Fatal
// because that bypasses slog and produces an unstructured line in production.
func exitFatal(event string, err error) {
	slog.Error(event, "err", err.Error())
	os.Exit(1)
}
