// Package runtime is the worker's lifecycle: register → heartbeat + poll →
// simulated execute → ack/nack → deregister. It is the *only* place in this
// service that knows about workers-table rows or runs background goroutines.
// cmd/worker/main.go does wiring; everything below is the loop.
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

// Config is the worker's startup configuration. All fields are required.
// Registry is the static set of handlers this worker can run; its Names() are
// advertised on the workers row (observability only — the dequeue path never
// reads workers.handlers[]).
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

// Worker is one runtime. Identity is the ULID generated at New; it must not
// outlive a single process boot (see project_ephemeral_worker_runtimes).
type Worker struct {
	cfg Config

	runtimeID string
}

// New builds a Worker with a fresh runtime ULID. The id is fixed for the life
// of this struct; it is the value the workers row will carry and the value
// every ClaimNextJob / MarkJob*ed call will identify with.
func New(cfg Config) *Worker {
	return &Worker{cfg: cfg, runtimeID: ulid.Make().String()}
}

// RuntimeID exposes the ULID main.go logs at startup.
func (w *Worker) RuntimeID() string { return w.runtimeID }

// Run is the entry point. It returns when ctx is cancelled (graceful shutdown)
// or after a fatal coordination failure. It does NOT return on transient
// errors — those are logged and retried.
//
// Shutdown contract (when ctx is cancelled):
//
//  1. pollLoop sees ctx.Done() and returns immediately — no new claims.
//  2. Any in-flight executeJob sees its jobCtx cancelled (jobCtx is derived
//     from this ctx), sleep(jobCtx, …) returns false, and we deliberately
//     SKIP ack/nack — the in-progress job is left to lease-expire so reclaim
//     remains authoritative. We do NOT fake-complete to "be polite"; faking
//     would corrupt outcomes.
//  3. The per-job lease renewer goroutines see jobCtx.Done() and exit. No
//     more RenewLease calls go out.
//  4. The worker heartbeat goroutine sees ctx.Done() and exits.
//  5. We do a best-effort deregister with a fresh short-lived context so the
//     workers row flips to 'disconnected' even though rootCtx is done.
//
// All of the above is the foundation of "containers WILL restart": the worker
// hands ownership of its in-flight jobs to the queue (lease expiry → reclaim)
// rather than trying to complete them itself.
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

	// Heartbeat runs on its own goroutine and uses the same root ctx. On a
	// 0-rows heartbeat it exits the process — that terminates before reaching
	// the deferred deregister below, which is correct: our workers row no
	// longer exists, so there's nothing to deregister.
	var wg sync.WaitGroup
	wg.Go(func() { w.heartbeatLoop(ctx) })

	// Poll loop blocks until ctx done. Errors from claim are logged-and-
	// retried; we only return when ctx is cancelled.
	w.pollLoop(ctx)

	// ctx already cancelled at this point. Announce the shutdown narrative
	// so the operator log has an unambiguous "begin → drain → complete"
	// arc; the lines between heartbeatLoop's exit and deregister are the
	// drain phase.
	slog.Info("worker.shutdown.begin",
		"workerId", w.runtimeID,
		"reason", ctxErrString(ctx),
		"action", "draining heartbeat + lease renewers, then deregistering",
	)

	// ctx already cancelled at this point; the heartbeat goroutine sees it
	// on the next tick and returns.
	wg.Wait()

	// Best-effort deregister with a fresh short-lived ctx. Failure here is
	// logged but not returned: the worker process is going down regardless.
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

// register INSERTs the workers row. state='active' so the operator UI sees
// the runtime immediately; the heartbeat keeps it alive.
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

// deregister moves the workers row into state='disconnected'. Operators see
// this as "graceful shutdown"; reclaim of any leases the worker still held
// proceeds via the normal lease-expiry path.
func (w *Worker) deregister(ctx context.Context) error {
	const sql = `UPDATE workers SET state = 'disconnected' WHERE id = $1`
	if _, err := w.cfg.Pool.Exec(ctx, sql, w.runtimeID); err != nil {
		return fmt.Errorf("workers deregister: %w", err)
	}
	return nil
}

// heartbeatLoop runs until ctx is cancelled. Each tick UPDATEs
// last_heartbeat_at; a 0-rows result means our workers row has been deleted
// and the runtime's identity is gone — fatal exit so the supervisor restarts
// us with a fresh ULID. Transient errors are logged and the next tick retries.
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
				// The workers row for this runtime no longer exists, so the
				// runtime's identity is gone and every lease guard we hold is
				// stale. There is no recovery — exit immediately so the
				// supervisor restarts us with a fresh ULID. We do NOT call
				// log.Fatal because that bypasses slog; we want the eviction
				// to surface as a structured ERROR line first.
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

// heartbeat does one UPDATE. Returns ok=true if the workers row still exists
// for this runtime, ok=false if the UPDATE affected zero rows.
func (w *Worker) heartbeat(ctx context.Context) (bool, error) {
	const sql = `UPDATE workers SET last_heartbeat_at = now() WHERE id = $1`
	cmd, err := w.cfg.Pool.Exec(ctx, sql, w.runtimeID)
	if err != nil {
		return false, err
	}
	return cmd.RowsAffected() == 1, nil
}

// pollLoop is the main loop. It calls ClaimNextJob every PollInterval; when
// it gets a job it processes it (which itself takes SimulatedExecution time)
// and then immediately polls again without an interval — there might be more
// work waiting.
func (w *Worker) pollLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}

		job, err := w.cfg.Repo.ClaimNextJob(ctx, w.runtimeID, w.cfg.Queues)
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

// executeJob is the per-job lifecycle: log start, spawn the lease renewer,
// dispatch to the registered handler, then call MarkJobSucceeded or
// MarkJobFailed based on what the handler returned.
//
// The renewer runs on its own goroutine for the duration of execution and
// shares a derived jobCtx with this function. Three things can cancel that
// jobCtx, all surfaced to the handler as ctx cancellation and observed here
// via jobCtx.Err() being non-nil after Handle returns:
//
//   - parent ctx cancelled (worker shutdown) — propagates through derivation
//   - this function returns (deferred jobCancel)
//   - the renewer's RenewLease call returned a sentinel and the renewer
//     called jobCancel — per SPEC §4.5, the worker MUST abort execution
//     immediately when the lease is lost/expired.
//
// In all three cases we return without calling ack/nack; the lease is left to
// expire (or has already), and reclaim handles it.
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
		// We have no "do-not-retry" signal yet (that would be a queue-semantic
		// change and is spec-first work), so we record a structured failure
		// and let the normal retry/DLQ pipeline run its course. Stop the
		// renewer first so completion runs under the parent ctx.
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

	// If execution was interrupted — worker shutdown, or the renewer cancelled
	// jobCtx on lease loss — the row's outcome belongs to whoever reclaims it.
	// Do NOT ack/nack; leave the lease to expire. jobCtx.Err() is the
	// authoritative signal (a handler returning ctx.Err() on its own would
	// also land here). This is the same contract the simulation honored.
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

	// Work finished under a live lease. Stop the renewer before ack/nack so a
	// stray late renewal doesn't race with completion. Use the parent ctx (not
	// jobCtx) for the completion call so a jobCancel from a racing renewer
	// cannot truncate the ack/nack mid-transaction.
	jobCancel()

	if herr != nil {
		w.nackJob(ctx, job, start, herr)
		return
	}
	w.ackJob(ctx, job, start, result)
}

// runLeaseRenewer is the per-job renewal loop. It ticks at
// LeaseRenewalInterval and calls queuecore.RenewLease; on any error from
// {ErrJobNotFound, ErrLeaseLost, ErrLeaseExpired} (or any other non-cancel
// error) it calls jobCancel to abort execution. See SPEC §4.5 + §4.6.
//
// This is per-job, NOT per-worker. It is structurally distinct from the
// worker heartbeat (which UPDATEs workers.last_heartbeat_at).
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

// ackJob calls MarkJobSucceeded with the result payload the handler returned
// (may be nil). Lease-loss / lease-expired here are warnings, not errors: they
// mean another worker has already reclaimed.
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

// nackJob calls MarkJobFailed with the handler's failure. A *handler.Error
// carries an explicit Class (e.g. "SimulatedFailure", "UnknownHandler",
// "http_5xx") recorded verbatim so the operator UI can group failures, and
// may set Permanent=true to force an immediate DLQ (SPEC §7). Any other
// error is recorded under the generic "HandlerError" class with
// Permanent=false (conservatively retryable). Same lease-loss handling as
// ackJob.
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

// logCompletionError emits the right log level depending on which sentinel
// the completion call returned. Lease loss is expected when the lease was
// reclaimed mid-execution — it's a warning, not an error. Anything else is
// a real failure.
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
// Used by execute.interrupted logs to disambiguate "parent ctx cancelled
// (shutdown)" from "renewer cancelled jobCtx (lease lost)".
func ctxErrString(ctx context.Context) string {
	if err := ctx.Err(); err != nil {
		return err.Error()
	}
	return "<nil>"
}

// sleep returns true if the duration elapsed, false if ctx was cancelled first.
// Callers branch: false → exit the loop.
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
