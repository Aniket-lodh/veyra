# apps/worker

Go service that leases jobs from the queue, executes them, and reports outcomes back through `packages/queue-core`.

## Current scope

The worker proves out coordination and now dispatches each job to a registered handler:

- Generates a fresh runtime ULID at startup (ephemeral per process boot; see `project_ephemeral_worker_runtimes`).
- INSERTs one row into `workers` advertising itself. The advertised `handlers[]` is the registry's `Names()` — observability only; the dequeue path never reads `workers.handlers[]` (queue-core SPEC §1.2).
- **Process heartbeat:** every 10s, `UPDATE workers SET last_heartbeat_at = now() WHERE id = $me`. **If 0 rows affected → exit.** The runtime's identity has been deleted; the supervisor restarts with a fresh ULID. This proves the *runtime* is alive — it is **not** the per-job lease renewal below.
- **Per-job lease renewal:** for each in-flight job, a dedicated goroutine calls `queuecore.Repository.RenewLease` every 10s (lease is 30s; see queuecore SPEC §4). On any renewal failure (`ErrLeaseLost` / `ErrLeaseExpired` / `ErrJobNotFound`) the goroutine cancels the job's execution context — the worker MUST abort, no ack/nack, lease left to expire so reclaim picks it up.
- Polls every 1s with `queuecore.Repository.ClaimNextJob`.
- **Executes** by looking the job's `handler` name up in the registry (`internal/handler`) and calling `Handle(jobCtx, job)`:
  - success → `MarkJobSucceeded` with the handler's returned result payload;
  - failure → `MarkJobFailed` with the error's class (a `*handler.Error` carries an explicit class; any other error is recorded as `HandlerError`);
  - `jobCtx` cancelled during `Handle` (shutdown or lease loss) → no ack/nack, lease left to expire for reclaim;
  - unknown handler name → recorded as a failure with `class=UnknownHandler` and run through the normal retry/DLQ pipeline (there is no "do-not-retry" signal yet — that would be a queue-semantic change and is spec-first work).
- On `SIGINT`/`SIGTERM`: cancels the root ctx, lets pollers and renewers exit, sets `state='disconnected'` on its workers row.

### Handler registry (`internal/handler`)

Static `name → Handler` map built once in `main.go` before `Run` — no dynamic registration, no plugins, no reflection. A handler is `Handle(ctx, *queuecore.Job) (json.RawMessage, error)` and **must be idempotent** (a job can run more than once across lease expiry / reclaim / retry) and **must respect ctx cancellation**. Registered handlers today:

- **`noop`** — sleeps `simulatedExecution` (5s), then succeeds or injects a `SimulatedFailure` at `VEYRA_WORKER_FAILURE_PERCENT` (0–100, default 20; set ~80 for retry-storm soaks). This carries the simulated work the soak/chaos harness depends on.
- **`http_request`** — generic outbound HTTP (webhook delivery is one use case). Payload `{url, method=POST, headers, body, timeoutSeconds}`. Per-request deadline is a child of the job context, so `timeoutSeconds` (default 30, capped 300) is honored without ever outliving the lease. 2xx → success with a rich result `{statusCode, durationMs, contentType, responseExcerpt}`; non-2xx / timeout / dns / connection_refused / transport → `*handler.Error` with a grouping class (`http_4xx`, `http_5xx`, `timeout`, `dns`, `connection_refused`, `connection`, `invalid_payload`). It does **not** retry internally — the queue's Nack path honors `handler.Error.Permanent` (SPEC §7). Permanence is **per status code**: other 4xx + `invalid_payload` are permanent; **408 and 429 stay retryable**; 5xx / timeout / dns / connection stay retryable.

  **Delivery-identity headers (at-least-once dedupe aid).** Veyra is at-least-once: a retry or reclaim re-run resends the request, so a receiver can see the same delivery more than once. Every `http_request` sends:
  - `X-Veyra-Job-Id` — the job's ULID, **stable across all attempts** (the dedupe key).
  - `X-Veyra-Attempt` — the attempt number, increments per redelivery.
  - `Idempotency-Key` — defaults to the job id (so receivers using the conventional header dedupe for free); a caller-supplied `Idempotency-Key` in `payload.headers` is left untouched.

  Receivers that must not act twice should dedupe on `X-Veyra-Job-Id` (or `Idempotency-Key`). This is handler-side only — it adds no queue semantics.

- **`send_email`** — outbound email via SMTP. Payload is content only: `{to, from?, subject, text?, html?, cc?, bcc?, replyTo?, headers?}`. At least one of `text`/`html` required. SMTP credentials come from worker env (`VEYRA_SMTP_HOST`, `VEYRA_SMTP_PORT` default 587, `VEYRA_SMTP_USERNAME`/`PASSWORD`, `VEYRA_SMTP_FROM`, `VEYRA_SMTP_TLS` = `starttls`|`tls`|`none`) — **never** from the job payload. If host is unset the handler still registers; `Handle` returns permanent `smtp_config`. Success result `{messageId, to, durationMs}`. Default `Message-ID` is `<{jobId}@veyra>` (caller `Message-ID` in headers wins). Failure classes: `invalid_payload` (permanent), `smtp_config` (permanent), `smtp_auth` (permanent), `smtp_reject` (permanent), `smtp_4xx` / `timeout` / `connection` (retryable). No internal retries — queue Nack owns that (SPEC §7). Soft caps: 50 recipients (to+cc+bcc), 256 KiB combined body.

Not yet (each a future task): payload deserialization helpers, concurrency pools (`max_concurrency=1` today), graceful drain.

The future-state conventions in the sections below already hold — they describe where this is going.

---

## Stack

Same as `apps/api`: Go, `pgx`. Structured logging via the local
`internal/logging` package (slog default, near-copy of the api's bootstrap —
see the repo-root CLAUDE.md for why this is deliberately not yet shared).
No HTTP server here today; future `/healthz` and `/metrics` will be added
when they have an actual consumer.

## Conventions

- **`context.Context` first**, same rule as the API.
- **Idempotency is the worker's responsibility.** A job handler may run more than once (lease expiry, crash, retry). Handlers must be idempotent or guard with a uniqueness key recorded in the job payload.
- **Leases are heartbeated.** Long-running handlers must extend their lease via the queue-core API; do not silently exceed lease duration.
- **Crash safety.** No in-memory state survives a crash. Anything that must be remembered crosses a Postgres write before the worker acknowledges the side-effect.
- **One handler, one concern.** Composite jobs are workflows, not handlers — express them as multiple jobs.
- **Observability mandatory.** Every job execution emits start / end logs with `job_id`, `attempt`, `duration_ms`, `outcome`. Metrics: per-handler latency histogram + outcome counter.

## Retry & dead-letter

Retry and DLQ policy lives in `apps/api/internal/retries/` and is governed by the queue-core spec. The worker does **not** decide retry policy — it reports outcomes and lets the queue layer schedule the next attempt. If you find yourself wanting to add retry logic in the worker, stop and read [the queue spec ADR](../../docs/decisions/0004-queue-semantics-documented-before-implementation.md).

## Testing

- `go test ./...` from `apps/worker/`.
- Handler tests use a real Postgres + a real queue-core instance. Mocking the queue defeats the test.
- Crash-safety tests: simulate process exit between side-effect and ack; verify the next attempt is correct.
