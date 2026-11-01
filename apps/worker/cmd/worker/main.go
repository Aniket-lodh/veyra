// Veyra worker. Boots, registers, heartbeats, polls, dispatches each job to a
// registered handler, ack/nacks. The handler registry is built here at boot;
// see apps/worker/CLAUDE.md for the handler contract and the current handler
// set. The "noop" handler carries the simulated work the soak harness uses.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/worker/internal/handler"
	"github.com/Aniket-lodh/veyra/worker/internal/logging"
	"github.com/Aniket-lodh/veyra/worker/internal/runtime"
)

const (
	serviceName   = "veyra-worker"
	workerVersion = "0.1.0"

	heartbeatInterval = 10 * time.Second
	// leaseRenewalInterval is the per-job RenewLease cadence. The queue's
	// lease is 30s (queuecore SPEC §1.8), so 10s gives 3 attempts per lease
	// window with ~20s margin for transient DB latency. Distinct from the
	// worker heartbeat above — see queuecore SPEC §4 for the why.
	leaseRenewalInterval  = 10 * time.Second
	pollInterval          = 1 * time.Second
	simulatedExecution    = 5 * time.Second
	defaultFailurePercent = 20 // rand.IntN(100) < n → simulated nack. Override via VEYRA_WORKER_FAILURE_PERCENT for soak storms.
	maxConcurrency        = 1  // advertised on the workers row; one job at a time

	dbPingTimeout = 5 * time.Second
)

func main() {
	// .env first, then logger — env values configure the logger.
	envMissing := godotenv.Load() != nil

	appEnv := envOr("APP_ENV", "development")
	logger := logging.Setup(appEnv, os.Getenv("LOG_LEVEL"))
	logger.Info("service.starting",
		"service", serviceName,
		"version", workerVersion,
		"env", appEnv,
		"envFileMissing", envMissing,
	)

	databaseURL := loadDatabaseURL()
	queues := loadCSV("VEYRA_WORKER_QUEUES", []string{"default"})
	failurePercent := loadFailurePercent()

	// The handler registry is the worker's static set of executable handlers,
	// built once here before Run. It is also the source of truth for the
	// handler names advertised on the workers row (observability only). The
	// "noop" handler carries the simulated sleep + failure injection that the
	// soak/chaos harness relies on; real handlers (http_request, …) register
	// here too as they land.
	registry := handler.NewRegistry()
	registry.Register("noop", handler.NewNoop(simulatedExecution, failurePercent))
	registry.Register("http_request", handler.NewHTTPRequest())
	smtpCfg := loadSMTPConfig()
	registry.Register("send_email", handler.NewSendEmail(smtpCfg))
	if smtpCfg.Configured() {
		slog.Info("worker.smtp.configured",
			"host", smtpCfg.Host,
			"port", smtpCfg.Port,
			"tls", smtpCfg.TLS,
			"hasAuth", smtpCfg.Username != "",
			"defaultFromSet", smtpCfg.From != "",
		)
	} else {
		slog.Warn("worker.smtp.unconfigured",
			"hint", "send_email jobs will fail with smtp_config until VEYRA_SMTP_HOST is set",
		)
	}

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown"
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(rootCtx, databaseURL)
	if err != nil {
		exitFatal("service.db.connect_failed", err)
	}
	defer pool.Close()

	pingCtx, pingCancel := context.WithTimeout(rootCtx, dbPingTimeout)
	if err := pool.Ping(pingCtx); err != nil {
		pingCancel()
		exitFatal("service.db.ping_failed", err)
	}
	pingCancel()
	slog.Info("service.db.ping_ok")

	repo := queuecore.NewRepository(pool)

	w := runtime.New(runtime.Config{
		Pool:                 pool,
		Repo:                 repo,
		Registry:             registry,
		Hostname:             hostname,
		Version:              workerVersion,
		Queues:               queues,
		HeartbeatInterval:    heartbeatInterval,
		LeaseRenewalInterval: leaseRenewalInterval,
		PollInterval:         pollInterval,
		MaxConcurrency:       maxConcurrency,
	})

	slog.Info("worker.bootstrap",
		"workerId", w.RuntimeID(),
		"hostname", hostname,
		"queues", queues,
		"handlers", registry.Names(),
		"heartbeatSeconds", int(heartbeatInterval/time.Second),
		"leaseRenewalSeconds", int(leaseRenewalInterval/time.Second),
		"pollSeconds", int(pollInterval/time.Second),
		"failurePercent", failurePercent,
	)

	// Background goroutine: log "service.stopping" the moment the signal
	// arrives, separately from "worker.shutdown.{begin,complete}" which
	// fire inside Run. The two logs together let an operator see:
	//   service.stopping  ← signal received
	//   worker.shutdown.begin   ← pollLoop returned, draining
	//   worker.deregistered     ← workers row flipped
	//   worker.shutdown.complete ← Run() returns
	//   service.stopped   ← about to exit
	go func() {
		<-rootCtx.Done()
		slog.Info("service.stopping",
			"service", serviceName,
			"workerId", w.RuntimeID(),
			"reason", "signal",
		)
	}()

	if err := w.Run(rootCtx); err != nil {
		exitFatal("worker.run_failed", err)
	}
	slog.Info("service.stopped",
		"service", serviceName,
		"workerId", w.RuntimeID(),
	)
}

// loadDatabaseURL prefers VEYRA_WORKER_DATABASE_URL when set; otherwise it
// assembles a URL from the same DB_* env vars the api uses. The two services
// deliberately share the env-var convention so a single .env can drive both.
func loadDatabaseURL() string {
	if u := strings.TrimSpace(os.Getenv("VEYRA_WORKER_DATABASE_URL")); u != "" {
		return u
	}
	host := envOr("DB_HOST", "localhost")
	port := envOr("DB_PORT", "5432")
	user := envOr("DB_USER", "veyra")
	pass := envOr("DB_PASSWORD", "veyra")
	name := envOr("DB_NAME", "veyra")
	sslmode := envOr("DB_SSLMODE", "disable")

	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(user, pass),
		Host:   fmt.Sprintf("%s:%s", host, port),
		Path:   "/" + name,
	}
	q := u.Query()
	q.Set("sslmode", sslmode)
	u.RawQuery = q.Encode()
	return u.String()
}

// loadFailurePercent reads VEYRA_WORKER_FAILURE_PERCENT and clamps it to
// [0, 100]. Unset / unparseable falls back to defaultFailurePercent so the
// container has the same behavior whether or not the operator set it.
func loadFailurePercent() int {
	raw := strings.TrimSpace(os.Getenv("VEYRA_WORKER_FAILURE_PERCENT"))
	if raw == "" {
		return defaultFailurePercent
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("config.failure_percent.invalid",
			"value", raw, "fallback", defaultFailurePercent,
			"err", err.Error(),
		)
		return defaultFailurePercent
	}
	switch {
	case n < 0:
		return 0
	case n > 100:
		return 100
	default:
		return n
	}
}

func loadCSV(key string, def []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// loadSMTPConfig reads VEYRA_SMTP_* for the send_email handler. Credentials
// stay on the worker — never in job payloads (see apps/worker/CLAUDE.md).
func loadSMTPConfig() handler.SMTPConfig {
	port := 587
	if raw := strings.TrimSpace(os.Getenv("VEYRA_SMTP_PORT")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			port = n
		} else {
			slog.Warn("config.smtp_port.invalid", "value", raw, "fallback", 587)
		}
	}
	return handler.SMTPConfig{
		Host:     strings.TrimSpace(os.Getenv("VEYRA_SMTP_HOST")),
		Port:     port,
		Username: strings.TrimSpace(os.Getenv("VEYRA_SMTP_USERNAME")),
		Password: os.Getenv("VEYRA_SMTP_PASSWORD"), // do not Trim — passwords may have spaces
		From:     strings.TrimSpace(os.Getenv("VEYRA_SMTP_FROM")),
		TLS:      strings.TrimSpace(os.Getenv("VEYRA_SMTP_TLS")),
	}
}

// exitFatal emits one structured ERROR line and exits 1. Used for startup
// failures where we cannot meaningfully continue. We do NOT use log.Fatal
// because that bypasses slog and produces an unstructured line in production.
func exitFatal(event string, err error) {
	slog.Error(event, "err", err.Error())
	os.Exit(1)
}
