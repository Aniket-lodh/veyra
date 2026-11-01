# apps/worker

Go service. It claims jobs from the queue, runs the registered handler for each job,
and reports the outcome through `packages/queue-core`.

## Runtime behavior

- **Identity.** Each process start generates a fresh ULID runtime id. The id is
  ephemeral: a restart gets a new id. See `docs/architecture/database-schema.md`, "Worker identity".
- **Registration.** On startup, the worker inserts one row into `workers`. It advertises
  `queues` and `handlers` for observability. Dequeue never reads these columns.
- **Heartbeat.** Every 10 seconds, the worker updates its `workers` row. If the row no
  longer exists (0 rows affected), the process exits, and the supervisor restarts it with a new id.
- **Claim.** Every 1 second, the worker calls `ClaimNextJob` for its queues. Each call
  claims at most one job, and the worker runs jobs one at a time (`max_concurrency = 1`).
- **Lease renewal.** For each in-flight job, a goroutine calls `RenewLease` every 10
  seconds. The lease lasts 30 seconds. If renewal fails with `ErrLeaseLost`,
  `ErrLeaseExpired`, or `ErrJobNotFound`, the worker cancels the job's context. It must not ack or nack, and it leaves the lease to expire.
- **Outcome.**
  - Handler returns a result: `MarkJobSucceeded` with that result.
  - Handler returns an error: `MarkJobFailed` with the error's class. A `*handler.Error`
    carries its own class and a `Permanent` flag. Any other error is recorded as `HandlerError`.
  - Job context cancelled during the handler (shutdown or lease loss): no ack, no nack.
  - Jobs for handlers this worker does not run are never claimed by it (SPEC §1.2). Other workers can claim them.
- **Shutdown.** On `SIGINT` or `SIGTERM`, the worker stops polling, drains the heartbeat
  and renewal goroutines, and marks its `workers` row `disconnected` with a short fresh context.

## Handler contract

Handlers live in `internal/handler` and are registered statically in `cmd/worker/main.go`.
No plugins, no reflection.

```go
Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error)
```

- **Idempotent.** A job can run more than once after lease expiry, reclaim, or retry.
  Guard side effects with a stable key. `http_request` sends `X-Veyra-Job-Id` and an `Idempotency-Key` header for this purpose.
- **Respect `ctx`.** Stop promptly when it is cancelled. Do not outlive the lease.
- **Do not retry internally.** Return an error. The queue's nack path decides retries
  through `handler.Error.Permanent` (SPEC §7).
- **One handler, one concern.** Composite work is a workflow of multiple jobs.

### Registered handlers

- **`noop`**: sleeps for 5 seconds, then succeeds, or fails with `SimulatedFailure` at
  `VEYRA_WORKER_FAILURE_PERCENT` (0–100, default 20). Used by the soak and chaos scripts.
- **`http_request`**: outbound HTTP. Payload `{url, method (default POST), headers, body, timeoutSeconds (default 30, max 300)}`.
  - 2xx: success, with result `{statusCode, durationMs, contentType, responseExcerpt}`.
  - Failures: `*handler.Error` with class `http_4xx`, `http_5xx`, `timeout`, `dns`,
    `connection_refused`, `connection`, or `invalid_payload`.
  - Permanence is per status code. Other 4xx and `invalid_payload` are permanent. **408 and 429
    stay retryable**, as do 5xx, timeouts, DNS, and connection errors.
  - Headers sent: `X-Veyra-Job-Id` (stable across attempts), `X-Veyra-Attempt`, and `Idempotency-Key`
    (defaults to the job id; a caller-supplied value is kept).
- **`send_email`**: SMTP delivery. Payload `{to, from?, subject, text?, html?, cc?, bcc?, replyTo?, headers?}`.
  At least one of `text` or `html` is required. Limits: 50 recipients total, 256 KiB body.
  - SMTP settings come from the worker environment only (`VEYRA_SMTP_*`). They never come from the payload.
  - Missing host: permanent `smtp_config`. Auth failure: permanent `smtp_auth`. Rejected
    message: permanent `smtp_reject`. Temporary 4xx, timeouts, and connection failures
    are retryable (`smtp_4xx`, `timeout`, `connection`).
  - Default `Message-ID` is `<{jobId}@veyra>`. A caller-supplied `Message-ID` header wins.

## Observability

Structured `slog` events, with `jobId`, `attempt`, and `duration_ms` where they apply.
Examples: `worker.execute.start`, `worker.ack.success`, `worker.nack.success`,
`worker.renewal.ok`, `worker.renewal.failed`, `worker.heartbeat.ok`, `worker.shutdown.complete`.
There is no metrics endpoint yet.

## Stack and layout

- Go, `pgx`, and the local `internal/logging` package (slog). The worker does not expose HTTP.
- `cmd/worker`: wiring. `internal/runtime`: poll, heartbeat, renewal, shutdown.
  `internal/handler`: registry and handlers. `internal/logging`: slog setup.

## Testing

- `go test ./...` from `apps/worker/`.
- Handler tests use `httptest` servers and a fake SMTP sender. They need no database.
- Runtime behavior (claim, renewal, crash recovery) is not yet covered by automated
  tests. The soak and chaos scripts (`scripts/soak`, `scripts/chaos`) exercise it by hand.
- Crash-safety rule: nothing lives only in memory. Any state that must survive a crash is written to Postgres before the worker acks.
