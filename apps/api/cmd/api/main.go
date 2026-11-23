package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/contrib/v3/swaggerui"
	"github.com/joho/godotenv"

	"github.com/Aniket-lodh/veyra/api/internal/auth"
	"github.com/Aniket-lodh/veyra/api/internal/callbacks"
	"github.com/Aniket-lodh/veyra/api/internal/config"
	"github.com/Aniket-lodh/veyra/api/internal/database"
	"github.com/Aniket-lodh/veyra/api/internal/debug"
	"github.com/Aniket-lodh/veyra/api/internal/health"
	apihttp "github.com/Aniket-lodh/veyra/api/internal/http"
	"github.com/Aniket-lodh/veyra/api/internal/jobs"
	"github.com/Aniket-lodh/veyra/api/internal/live"
	"github.com/Aniket-lodh/veyra/api/internal/logging"
	"github.com/Aniket-lodh/veyra/api/internal/queues"
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

	portNum, err := config.ValidatePort(cfg.Port)
	if err != nil {
		slog.Error("service.config.invalid_port", "port", cfg.Port, "err", err.Error())
		exitFatal("service.config.invalid_port", fmt.Errorf("invalid PORT %q: %w", cfg.Port, err))
	}

	addr := fmt.Sprintf(":%d", portNum)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("service.http.bind_failed",
			"service", serviceName,
			"addr", addr,
			"port", portNum,
			"err", err.Error(),
		)
		exitFatal("service.http.bind_failed", fmt.Errorf("failed to bind strictly to address %s (port %d): %w", addr, portNum, err))
	}
	defer ln.Close()

	logger := logging.Setup(cfg.AppEnv, os.Getenv("LOG_LEVEL"))
	logger.Info("service.starting",
		"service", serviceName,
		"env", cfg.AppEnv,
		"port", portNum,
		"envFileMissing", envMissing,
	)

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

	// Swagger is a developer-facing UI, not a product feature.
	if cfg.IsDevelopment() {
		app.Use(swaggerui.New(swaggerui.Config{
			BasePath: "/",
			FilePath: "./docs/swagger.json",
			Path:     "swagger",
			Title:    "Swagger API Docs",
		}))
		slog.Info("service.swagger.mounted", "path", "/swagger")
	}

	authStore := auth.NewStore(dbPool)
	authn := &auth.Authenticator{
		Store:         authStore,
		SecureCookies: !cfg.IsDevelopment(),
	}
	userCount, err := authStore.CountUsers(rootCtx)
	if err != nil {
		exitFatal("service.auth.users_count_failed", err)
	}
	slog.Info("service.auth.ready",
		"bootstrapped", userCount > 0,
		"users", userCount,
		"secureCookies", authn.SecureCookies,
	)

	jobRepo := queuecore.NewRepository(dbPool)
	liveHub := live.NewHub()

	health.Register(app, health.NewHandler(dbPool))
	auth.RegisterAuth(app, auth.NewSessionHandler(authStore, authn))
	jobs.Register(app, jobs.NewHandler(jobRepo, liveHub), authn)
	queues.Register(app, queues.NewHandler(jobRepo, liveHub), authn)
	stats.Register(app, stats.NewHandler(jobRepo), authn)
	workers.Register(app, workers.NewHandler(dbPool, jobRepo, liveHub), authn)
	if cfg.EnableDebugEndpoints {
		debug.Register(app, debug.NewHandler(jobRepo), authn)
		slog.Info("service.debug_routes.mounted", "path", "/internal/debug/*")
	} else {
		slog.Info("service.debug_routes.disabled")
	}
	auth.Register(app, auth.NewHandler(authStore, authn))

	live.Register(app, liveHub, authn)
	liveListener := live.NewListener(cfg.DatabaseURL(), liveHub)
	go func() {
		if err := liveListener.Run(rootCtx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("service.live_listener.failed", "err", err.Error())
		}
	}()

	sweeper := workers.NewSweeper(dbPool, cfg.SweeperInterval)
	go func() {
		if err := sweeper.Run(rootCtx); err != nil {
			slog.Error("service.sweeper.failed", "err", err.Error())
		}
	}()

	retryScheduler := retries.NewScheduler(dbPool, cfg.RetryInterval, cfg.RetryBatchLimit)
	go func() {
		if err := retryScheduler.Run(rootCtx); err != nil {
			slog.Error("service.retry_scheduler.failed", "err", err.Error())
		}
	}()

	reclaimDriver := reclaim.NewDriver(dbPool, cfg.ReclaimInterval, cfg.ReclaimBatchLimit)
	go func() {
		if err := reclaimDriver.Run(rootCtx); err != nil {
			slog.Error("service.reclaim_driver.failed", "err", err.Error())
		}
	}()

	callbackDispatcher := callbacks.NewDispatcher(dbPool, callbacks.Config{
		Interval:    cfg.CallbackInterval,
		BatchLimit:  cfg.CallbackBatchLimit,
		Timeout:     cfg.CallbackTimeout,
		Concurrency: cfg.CallbackConcurrency,
		Secret:      cfg.CallbackSecret,
	})
	go func() {
		if err := callbackDispatcher.Run(rootCtx); err != nil {
			slog.Error("service.callback_dispatcher.failed", "err", err.Error())
		}
	}()

	// Listen on a goroutine so the main goroutine can wait on signals AND the listener error in a single select.
	listenErr := make(chan error, 1)
	go func() {
		slog.Info("service.http.listening", "addr", addr, "port", portNum, "service", serviceName)
		listenErr <- app.Listener(ln)
	}()

	select {
	case err := <-listenErr:
		// http.ErrServerClosed is the canonical "we asked it to stop" return from fiber/fasthttp shutdown — distinguish from a true listener…
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
}

func exitFatal(event string, err error) {
	slog.Error(event, "err", err.Error())
	os.Exit(1)
}
