# Veyra: system overview

This is a map of the system. For exact semantics, read the spec
([`packages/queue-core/SPEC.md`](../../packages/queue-core/SPEC.md)). For column-level
reasoning, read [`database-schema.md`](database-schema.md). For a job's states and
transitions, read [`job-lifecycle.md`](job-lifecycle.md).

## Components

```
                ┌──────────────────────┐
                │  apps/frontend/app   │
                │  operator console    │
                └──────────┬───────────┘
                           │ HTTP (JSON)
                           ▼
                ┌──────────────────────┐
                │  apps/api            │
                │  REST API            │
                │  background loops:   │
                │   stale-worker       │
                │   sweeper, retry     │
                │   scheduler, reclaim │
                │   driver             │
                └──────────┬───────────┘
                           │ pgx
                           ▼
                ┌──────────────────────┐
                │   PostgreSQL 17      │
                │   jobs               │
                │   job_attempts       │
                │   workers            │
                └──────────┬───────────┘
                           │ pgx
                           ▼
                ┌──────────────────────┐
                │  apps/worker         │
                │  claim, execute,     │
                │  renew, ack / nack   │
                └──────────────────────┘
```

PostgreSQL is the only durable store. Every process is stateless, apart from the
in-memory state of the current request or job. See
[ADR-0002](../decisions/0002_postgresql-as-primary-store-and-queue.md).

## Shared code

- **`packages/queue-core`** is the only shared Go package. Both `apps/api` and
  `apps/worker` import it. It holds queue semantics and SQL. Its spec is
  `SPEC.md`. See [ADR-0004](../decisions/0004_queue-semantics-documented-before-implementation.md).
- Configuration loading and logging are per app today (`internal/config`,
  `internal/logging`). A shared package is created only when a second consumer
  needs the same code (`CLAUDE.md`).

## Where the code runs

| Concern | Location |
|---|---|
| Enqueue, inspect, cancel, list | `apps/api/internal/jobs` (HTTP), `packages/queue-core/repository.go` and `cancel.go` (SQL) |
| Claim, ack, nack, renew | `packages/queue-core/repository.go`, called by `apps/worker/internal/runtime` |
| Reclaim of expired leases | `packages/queue-core/reclaim.go` (primitive), `apps/api/internal/reclaim` (periodic tick), inline in claim |
| Retry promotion | `apps/api/internal/retries` |
| Stale-worker detection | `apps/api/internal/workers/sweeper.go` |
| Handlers (`noop`, `http_request`, `send_email`) | `apps/worker/internal/handler` |
| Migrations | `apps/api/migrations`, applied at API startup |

## Lifecycle of a job, in brief

1. **Enqueue.** `POST /jobs` validates the request and inserts a `queued` row.
   If the idempotency key already exists, the existing row is returned.
2. **Visible.** The row becomes claimable once `scheduled_for <= now()`.
3. **Claim.** A worker claims the highest-priority, oldest visible job from its
   queues. The claim sets `running`, writes a lease with a 30-second expiry, and
   starts an attempt.
4. **Renew.** While the handler runs, the worker renews the lease every 10 seconds.
5. **Outcome.**
   - **Ack:** the handler succeeded, and the job becomes `succeeded`.
   - **Nack:** the handler failed. The job becomes `failed` with a jittered
     `next_retry_at`, or `dead_lettered` if the failure is permanent or the attempt
     budget is spent.
   - **Lease expires** without renewal: the job is reclaimed. It returns to
     `queued`, or is dead-lettered if no budget remains.
   - **Cancel:** the job becomes `cancelled`. A running worker learns of this when
     its next renewal fails, and it must stop without acking.
6. **Inspect.** `GET /jobs/:id` returns the job and its attempt history.

For the exact transitions, see [`job-lifecycle.md`](job-lifecycle.md).

## Not in the system

- A separate message bus (Kafka, NATS, and similar). See [ADR-0003](../decisions/0003_no-premature-microservices-or-orchestrators.md).
- A cache. Postgres handles read load through indexes.
- Per-service databases. There is one Postgres.
- Kubernetes manifests. Docker Compose is the deployment target.
- Authentication and authorization. The API has none yet, so run it on a private network.
- Pause, drain, and DLQ replay. They are planned and not implemented.
