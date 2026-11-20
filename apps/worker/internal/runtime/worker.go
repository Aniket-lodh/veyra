// Package runtime is the worker lifecycle loop.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oklog/ulid/v2"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/worker/internal/handler"
)

// Config is the worker's startup configuration.
type Config struct {
	Pool     *pgxpool.Pool
	Repo     *queuecore.Repository
	Registry *handler.Registry

	Hostname string
	Version  string
	Queues   []string // dequeue capability filter (passed to ClaimNextJob)

	HeartbeatInterval    time.Duration // workers.last_heartbeat_at update cadence — proves the RUNTIME is alive
	LeaseRenewalInterval time.Duration // per-job RenewLease cadence — proves THIS JOB EXECUTION is healthy (queuecore SPEC §4)
	PollInterval         time.Duration // ClaimNextJob cadence when the queue is idle
	MaxConcurrency       int           // advertised on the workers row. Worker still runs serially.
}

// Worker is one runtime.
type Worker struct {
	cfg Config

	runtimeID string
}

// New builds a Worker with a fresh runtime ULID.
func New(cfg Config) *Worker {
	return &Worker{cfg: cfg, runtimeID: ulid.Make().String()}
}

// RuntimeID exposes the ULID main.go logs at startup.
func (w *Worker) RuntimeID() string { return w.runtimeID }

// Run is the entry point.
func (w *Worker) Run(ctx context.Context) error {
	if err := w.register(ctx); err != nil {
		return fmt.Errorf("runtime: register: %w", err)
	}
	slog.InfoContext(ctx, "worker.registered",
		"workerId", w.runtimeID,
		"hostname", w.cfg.Hostname,
		"version", w.cfg.Version,
		"queues", w.cfg.Queues,
		"handlers", w.cfg.Registry.Names(),
		"heartbeatSeconds", int(w.cfg.HeartbeatInterval/time.Second),
	)

	// Heartbeat runs on its own goroutine and uses the same root ctx.
	var wg sync.WaitGroup
	wg.Go(func() { w.heartbeatLoop(ctx) })

	// Poll loop blocks until ctx done.
	w.pollLoop(ctx)

	// ctx already cancelled at this point.
	slog.Info("worker.shutdown.begin",
		"workerId", w.runtimeID,
		"reason", ctxErrString(ctx),
		"action", "draining heartbeat + lease renewers, then deregistering",
	)

	// ctx already cancelled at this point; the heartbeat goroutine sees it on the next tick and returns.
	wg.Wait()

	// Best-effort deregister with a fresh short-lived ctx.
	dctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.deregister(dctx); err != nil {
		slog.WarnContext(dctx, "worker.deregister_failed",
			"workerId", w.runtimeID,
			"err", err.Error(),
		)
	} else {
		slog.InfoContext(dctx, "worker.deregistered", "workerId", w.runtimeID)
	}

	slog.Info("worker.shutdown.complete",
		"workerId", w.runtimeID,
		"hostname", w.cfg.Hostname,
	)
	return nil
}

// register INSERTs the workers row.
func (w *Worker) register(ctx context.Context) error {
	const sql = `
		INSERT INTO workers (
			id, hostname, pid, version, state,
			queues, handlers, max_concurrency, heartbeat_interval_seconds
		) VALUES (
			$1, $2, $3, $4, 'active',
			$5, $6, $7, $8
		)
	`
	_, err := w.cfg.Pool.Exec(ctx, sql,
		w.runtimeID,
		w.cfg.Hostname,
		os.Getpid(),
		w.cfg.Version,
		w.cfg.Queues,
		w.cfg.Registry.Names(),
		w.cfg.MaxConcurrency,
		int(w.cfg.HeartbeatInterval/time.Second),
	)
	if err != nil {
		return fmt.Errorf("workers insert: %w", err)
	}
	return nil
}

// deregister moves the workers row into state='disconnected'.
func (w *Worker) deregister(ctx context.Context) error {
	const sql = `UPDATE workers SET state = 'disconnected' WHERE id = $1`
	if _, err := w.cfg.Pool.Exec(ctx, sql, w.runtimeID); err != nil {
		return fmt.Errorf("workers deregister: %w", err)
	}
	return nil
}

// heartbeatLoop runs until ctx is cancelled.
func (w *Worker) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(w.cfg.HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ok, err := w.heartbeat(ctx)
			if err != nil {
				slog.ErrorContext(ctx, "worker.heartbeat.error",
					"workerId", w.runtimeID,
					"err", err.Error(),
				)
				continue
			}
			if !ok {
				// The workers row for this runtime no longer exists, so the runtime's identity is gone and every lease guard we hold is stale.
				slog.ErrorContext(ctx, "worker.heartbeat.runtime_evicted",
					"workerId", w.runtimeID,
					"reason", "0_rows_affected",
					"detail", "workers row gone — runtime identity vanished",
					"action", "exiting process for supervisor restart",
				)
				os.Exit(1)
			}
			slog.DebugContext(ctx, "worker.heartbeat.ok", "workerId", w.runtimeID)
		}
	}
}

// heartbeat does one UPDATE.
func (w *Worker) heartbeat(ctx context.Context) (bool, error) {
	const sql = `UPDATE workers SET last_heartbeat_at = now() WHERE id = $1`
	cmd, err := w.cfg.Pool.Exec(ctx, sql, w.runtimeID)
	if err != nil {
		return false, err
	}
	return cmd.RowsAffected() == 1, nil
}

// pollLoop is the main loop.
func (w *Worker) pollLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}

		job, err := w.cfg.Repo.ClaimNextJob(ctx, w.runtimeID, w.cfg.Queues, w.cfg.Registry.Names())
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return
			}
			slog.ErrorContext(ctx, "worker.poll.claim_error",
				"workerId", w.runtimeID,
				"err", err.Error(),
			)
			if !sleep(ctx, w.cfg.PollInterval) {
				return
			}
			continue
		}

		if job == nil {
			if !sleep(ctx, w.cfg.PollInterval) {
				return
			}
			continue
		}

		w.executeJob(ctx, job)
	}
}

// executeJob is the per-job lifecycle: log start, spawn the lease renewer, dispatch to the registered handler.
func (w *Worker) executeJob(ctx context.Context, job *queuecore.Job) {
	slog.InfoContext(ctx, "worker.execute.start",
		"workerId", w.runtimeID,
		"jobId", job.ID,
		"queue", job.Queue,
		"handler", job.Handler,
		"attempt", job.Attempt,
		"maxAttempts", job.MaxAttempts,
		"leaseRenewalSeconds", int(w.cfg.LeaseRenewalInterval/time.Second),
	)
	start := time.Now()

	jobCtx, jobCancel := context.WithCancel(ctx)
	defer jobCancel()
	go w.runLeaseRenewer(jobCtx, jobCancel, job)

	h, ok := w.cfg.Registry.Lookup(job.Handler)
	if !ok {
		// No handler registered for this name — a permanent misconfiguration.
		jobCancel()
		slog.ErrorContext(ctx, "worker.execute.unknown_handler",
			"workerId", w.runtimeID,
			"jobId", job.ID,
			"handler", job.Handler,
			"registered", w.cfg.Registry.Names(),
		)
		w.nackJob(ctx, job, start, &handler.Error{
			Class:   "UnknownHandler",
			Message: fmt.Sprintf("no handler registered for %q", job.Handler),
		})
		return
	}

	result, herr := h.Handle(jobCtx, job)

	// If execution was interrupted — worker shutdown, or the renewer cancelled jobCtx on lease loss — the row's outcome belongs to whoever reclaims it.
	if jobCtx.Err() != nil {
		slog.WarnContext(ctx, "worker.execute.interrupted",
			"workerId", w.runtimeID,
			"jobId", job.ID,
			"durationMs", time.Since(start).Milliseconds(),
			"parentCtxErr", ctxErrString(ctx),
			"action", "leaving lease to expire — next reclaim will pick it up",
		)
		return
	}

	// Work finished under a live lease.
	jobCancel()

	if herr != nil {
		w.nackJob(ctx, job, start, herr)
		return
	}
	w.ackJob(ctx, job, start, result)
}

// runLeaseRenewer is the per-job renewal loop.
func (w *Worker) runLeaseRenewer(jobCtx context.Context, jobCancel context.CancelFunc, job *queuecore.Job) {
	t := time.NewTicker(w.cfg.LeaseRenewalInterval)
	defer t.Stop()
	for {
		select {
		case <-jobCtx.Done():
			return
		case <-t.C:
			renewed, err := w.cfg.Repo.RenewLease(jobCtx, queuecore.RenewParams{
				WorkerID: w.runtimeID,
				JobID:    job.ID,
			})
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return
				}
				leaseLost := errors.Is(err, queuecore.ErrLeaseLost)
				leaseExpired := errors.Is(err, queuecore.ErrLeaseExpired)
				notFound := errors.Is(err, queuecore.ErrJobNotFound)
				ownershipGone := leaseLost || leaseExpired || notFound
				level := slog.LevelError
				if ownershipGone {
					level = slog.LevelWarn
				}
				slog.Log(jobCtx, level, "worker.renewal.failed",
					"workerId", w.runtimeID,
					"jobId", job.ID,
					"attempt", job.Attempt,
					"err", err.Error(),
					"leaseLost", leaseLost,
					"leaseExpired", leaseExpired,
					"notFound", notFound,
					"action", "cancelling job execution (SPEC §4.5)",
				)
				jobCancel()
				return
			}
			leaseStr := "(unset)"
			if renewed.LeaseExpiresAt != nil {
				leaseStr = renewed.LeaseExpiresAt.Format(time.RFC3339Nano)
			}
			slog.DebugContext(jobCtx, "worker.renewal.ok",
				"workerId", w.runtimeID,
				"jobId", job.ID,
				"attempt", job.Attempt,
				"newLeaseExpiresAt", leaseStr,
			)
		}
	}
}

// ackJob calls MarkJobSucceeded with the result payload the handler returned (may be nil).
func (w *Worker) ackJob(ctx context.Context, job *queuecore.Job, start time.Time, result json.RawMessage) {
	if _, err := w.cfg.Repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
		WorkerID: w.runtimeID,
		JobID:    job.ID,
		Result:   result,
	}); err != nil {
		w.logCompletionError(ctx, "worker.ack.error", job, err)
		return
	}
	slog.InfoContext(ctx, "worker.ack.success",
		"workerId", w.runtimeID,
		"jobId", job.ID,
		"attempt", job.Attempt,
		"durationMs", time.Since(start).Milliseconds(),
	)
}

// nackJob calls MarkJobFailed with the handler's failure.
func (w *Worker) nackJob(ctx context.Context, job *queuecore.Job, start time.Time, cause error) {
	class := "HandlerError"
	message := cause.Error()
	permanent := false
	var herr *handler.Error
	if errors.As(cause, &herr) {
		class = herr.Class
		message = herr.Message
		permanent = herr.Permanent
	}

	jerr := queuecore.JobError{
		Class:      class,
		Message:    message,
		OccurredAt: time.Now(),
	}
	res, err := w.cfg.Repo.MarkJobFailed(ctx, queuecore.FailParams{
		WorkerID:  w.runtimeID,
		JobID:     job.ID,
		Error:     jerr,
		Permanent: permanent,
	})
	if err != nil {
		w.logCompletionError(ctx, "worker.nack.error", job, err)
		return
	}
	slog.InfoContext(ctx, "worker.nack.success",
		"workerId", w.runtimeID,
		"jobId", job.ID,
		"attempt", job.Attempt,
		"errorClass", class,
		"permanent", permanent,
		"terminal", res.Status == queuecore.StatusDeadLettered,
		"finalStatus", string(res.Status),
		"durationMs", time.Since(start).Milliseconds(),
	)
}

// logCompletionError emits the right log level depending on which sentinel the completion call returned.
func (w *Worker) logCompletionError(ctx context.Context, event string, job *queuecore.Job, err error) {
	leaseLost := errors.Is(err, queuecore.ErrLeaseLost)
	leaseExpired := errors.Is(err, queuecore.ErrLeaseExpired)
	level := slog.LevelError
	if leaseLost || leaseExpired {
		level = slog.LevelWarn
	}
	slog.Log(ctx, level, event,
		"workerId", w.runtimeID,
		"jobId", job.ID,
		"attempt", job.Attempt,
		"err", err.Error(),
		"leaseLost", leaseLost,
		"leaseExpired", leaseExpired,
	)
}

// ctxErrString renders ctx.Err() as a short string ("<nil>" when alive).
func ctxErrString(ctx context.Context) string {
	if err := ctx.Err(); err != nil {
		return err.Error()
	}
	return "<nil>"
}

// sleep returns true if the duration elapsed, false if ctx was cancelled first.
func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
