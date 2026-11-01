# Veyra — System Overview

This is the top-level map of the system. For any subsystem, read the closest `CLAUDE.md` and the relevant ADRs in `docs/decisions/`.

## Components

```
                ┌──────────────────────┐
                │  apps/frontend       │
                │  (React, operator    │
                │   console)           │
                └──────────┬───────────┘
                           │ HTTP + WS
                           ▼
                ┌──────────────────────┐
                │  apps/api            │
                │  - public API        │
                │  - admin API         │
                │  - WebSocket stream  │
                └──────────┬───────────┘
                           │ pgx
                           ▼
                ┌──────────────────────┐
                │   PostgreSQL         │
                │   - jobs             │
                │   - queues           │
                │   - leases           │
                │   - attempts / DLQ   │
                │   - audit log        │
                └──────────┬───────────┘
                           │ pgx
                           ▼
                ┌──────────────────────┐
                │  apps/worker         │
                │  - lease + execute   │
                │  - heartbeat         │
                │  - ack / nack        │
                └──────────────────────┘
```

There is one Postgres. Everything else is a stateless process. See [ADR-0002](../decisions/0002_postgresql-as-primary-store-and-queue.md).

## Shared packages

- **`packages/queue-core`** — the queue primitives and their spec. Both `apps/api` (for enqueue, admin operations) and `apps/worker` (for lease/ack/nack) consume this. The spec in `packages/queue-core/SPEC.md` is the contract. See [ADR-0004](../decisions/0004_queue-semantics-documented-before-implementation.md).
- **`packages/config`** — config loading (env + file). One pattern for all apps.
- **`packages/logger`** — structured logging. One logger, used everywhere. Observability lives or dies on this being consistent.

## Lifecycle of a job

1. **Enqueue.** A caller hits `apps/api`'s public API. The handler validates, persists a job row via `packages/queue-core`, and returns.
2. **Visibility.** The job row has a `visible_at` (now, or future for scheduled jobs). It becomes returnable from dequeue once `visible_at <= now()` and it isn't already leased.
3. **Lease.** A worker calls dequeue (`SELECT ... FOR UPDATE SKIP LOCKED`), sets `leased_by` and `lease_expires_at`, commits.
4. **Heartbeat.** The worker extends `lease_expires_at` periodically while executing.
5. **Outcome.**
   - **Ack** — the worker reports success; the job moves to a terminal `succeeded` status.
   - **Nack** — the worker reports a recoverable failure; the retry layer sets a new `visible_at` based on backoff policy.
   - **Lease expiry without heartbeat** — treated as a failure; the retry layer schedules another attempt, incrementing the attempt count.
   - **Max attempts exceeded** — the job moves to `dead-lettered`; visible in operator UI for inspection/replay.
6. **Inspect / replay.** Operators can pause queues, drain workers, view per-job history, and re-enqueue dead-lettered jobs through the admin API.

For the exact semantics at each step, read `packages/queue-core/SPEC.md`. This document is a map, not a contract.

## What is intentionally *not* here

- A separate message bus (Kafka, NATS, etc.) — see [ADR-0003](../decisions/0003_no-premature-microservices-or-orchestrators.md).
- A separate cache (Redis, etc.) — Postgres handles read load via indexes; if we need caching later, we'll write an ADR.
- Per-service databases — one Postgres, one schema (with sub-schemas if needed).
- Kubernetes — Compose only, see [ADR-0003](../decisions/0003_no-premature-microservices-or-orchestrators.md).

## Where to deepen

- *Queue semantics:* `packages/queue-core/SPEC.md` (when it exists) and `apps/api/docs/architecture/job-lifecycle.md`.
- *Why a decision:* `docs/decisions/`.
- *Per-subsystem conventions:* the `CLAUDE.md` in that subtree.
