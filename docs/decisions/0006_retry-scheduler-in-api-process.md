# 0006 — Retry Scheduler Lives In The api Process

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Veyra core
- **Supersedes:** —

## Context

`SPEC.md §3.5` (Retry scheduling) splits the retry pipeline into two phases:

1. **Decide** — Nack computes `next_retry_at` and stores it on the failure tx.
2. **Promote** — a background scanner periodically flips retry-due rows from
   `failed` to `queued` so dequeue can see them.

The decision phase has a natural home (the Nack code path). The promote phase
does not. It is a stateless background loop that scans the `jobs` table and
issues a single atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
Multiple locations are plausible:

- **Inside the `apps/api` process**, alongside the stale-worker sweeper (see
  `apps/api/internal/workers/sweeper.go`).
- **A new top-level service** under `apps/scheduler/` with its own
  Dockerfile, healthcheck, compose entry, and lifecycle.
- **A SQL-only solution** via `pg_cron` or similar.

This ADR pins which.

## Decision

The retry scheduler runs as a **background goroutine inside the
existing `apps/api` process**, in a new package `apps/api/internal/retries/`.
Started from `cmd/api/main.go` bound to the same root context as the rest
of the api. Stopped on `SIGTERM` along with the HTTP server.

Concretely:

- One file owns the loop and one file owns the SQL. Same shape as the
  sweeper, which is already understood.
- The scheduler reads `next_retry_at` and writes `(status, next_retry_at)`.
  It does **not** touch any other column. This is enforced by code review
  and by SPEC.md §3.5.4 invariants, not by privilege separation.
- Singleton-by-deployment for now: there is one api process, so one
  scheduler. The SQL uses `FOR UPDATE SKIP LOCKED`, so multiple api
  replicas would also be safe (each tick would race to claim batches, and
  no row could be promoted twice). When the day comes that we run more
  than one api replica AND tick volume is high enough that duplicate work
  is a real cost, wrap the tick in `pg_try_advisory_lock`.

The scheduler's interval is configurable via `VEYRA_RETRY_INTERVAL_SECONDS`
(default `5`). The batch limit is `VEYRA_RETRY_BATCH_LIMIT` (default `256`).

## Alternatives considered

### Option B: new top-level `apps/scheduler/` service

Adds: a Dockerfile, a compose entry, a healthcheck, a deploy unit, restart
policy, log shipping, build pipeline entries, and the configuration
plumbing to connect it to the same Postgres as the api.

Buys: nothing today. The scheduler does no work the api can't do at near-
zero cost (it's an idle SQL polling loop). The argument for a separate
service is operational isolation — "if the scheduler is OOM, the api
keeps serving traffic." That argument has weight when the scheduler does
meaningful work, which this one does not. Its working set is a single
`UPDATE` returning at most `batchLimit` ids; its memory is bounded by a
small constant.

Cost: more deploy surface, more health-monitoring surface, two processes
to keep aligned with the schema, and a new top-level directory under
`apps/` that ADR-0003 ("no premature microservices") explicitly resists.

When this gets revisited: when the scheduler grows real responsibilities
(e.g. it ends up scanning a `queue_events` table for replay, or it
becomes the orchestrator for pause/drain), the work justifies the deploy
unit. Not today.

### Option C: pg_cron / SQL-only

The promote query is one statement and could in principle be scheduled
by `pg_cron`. Tempting because it eliminates app code entirely.

Rejected because:

- It moves the scheduler's observability into Postgres extension logs,
  which is an alien observability path for this stack. SPEC.md §3.5.10
  requires `queue.retry.promoted` events with `lagMs`; emitting those
  from `pg_cron` is awkward.
- It pushes a new operational dependency (`pg_cron`) into the schema
  contract, which would need its own ADR per ADR-0002 (Postgres-only —
  no extensions without a decision).
- It centralizes too much queue logic in SQL. Today the retry pipeline is
  10% SQL and 90% Go (the jitter, the lag computation, the structured
  events). Moving the promote loop to SQL would split the logic across
  two languages with no upside.

## Consequences

### Positive

- One fewer deploy unit. The scheduler ships with the api binary.
- One fewer healthcheck for operators to track. The api's `/health`
  liveness already covers the process the scheduler runs in; if the
  scheduler dies, the api process dies. (The goroutine itself
  surviving panic is a separate concern handled by Go's runtime.)
- Lower latency between Nack (which the api already serves through the
  debug endpoints today, and will eventually serve via worker→api RPC)
  and promote. Both run in the same process against the same pool.
- Matches the sweeper precedent. A second background loop in the same
  package shape is easier to reason about than two services using two
  different lifecycle conventions.

### Negative

- The api process owns work that is conceptually independent of HTTP
  serving. A long stack trace from the scheduler could appear in
  request-handling logs without a request id. Mitigation: every
  scheduler event includes its own correlation field set
  (`jobId`, `scheduledForRetryAt`) so timeline reconstruction does not
  depend on the request id.
- `docker compose down api` stops the scheduler too. That is the
  intended behavior for now (api owns retries → api stops → retries
  stop). Operators who need to take the api down without halting
  retries will have to wait until either (a) the api becomes
  replicated, or (b) the scheduler moves out of the api process. The
  scheduler moving out is the option this ADR explicitly defers — it
  is not blocked, just not done.

### Neutral

- Multiple api replicas would each run a scheduler. Safe (SKIP LOCKED),
  but duplicates the tick load on the DB. When this matters, add the
  advisory lock. Until then, we don't run multiple api replicas, so it
  doesn't matter.

## Operational notes

- Runbook: `docs/runbooks/retry-storm.md` (to be written alongside the
  implementation PR) — covers the symptoms and remediation for retry
  starvation, retry storms, and the budget-exhausted edge case.
- The 24h soak harness (`scripts/soak/run.sh`) already captures the
  metrics relevant to scheduler health: `jobs_in_flight`,
  `attempts_lease_lost`, `jobs_dlq_last_5m`. A new metric —
  `oldest_failed_due_lag` — will be added to `scripts/soak/sql/snapshot.sql`
  in the implementation PR to surface scheduler starvation.
