# Veyra — Database Schema

This document explains the schema of Veyra's coordination tables: **why** the columns exist, **what invariants** they enforce, and **how** the dequeue/lease/retry algorithm cooperates with them. It does not contain DDL — the migrations are the authoritative DDL. This is the reasoning behind the migrations.

If a future migration changes a column described here, this document must be updated in the same change. The shape of these tables is the contract that callers, workers, the retry layer, and the operator UI all rely on.

## What this document is for

Veyra's correctness lives in three places:

1. **The queue spec** (`packages/queue-core/SPEC.md`) — the observable semantics: what `Enqueue`, `Dequeue`, `Ack`, `Nack`, `Heartbeat`, `Cancel`, retry, and dead-letter actually mean to callers.
2. **The schema** (this document, plus the migrations in `apps/api/migrations/`) — how those semantics are *represented*: which columns hold the state, which constraints prevent illegal states, which indexes make the hot path fast.
3. **The code** — the implementation that moves rows between states under the rules from (1) and (2).

This document is layer (2). It must be read alongside (1); the two co-evolve.

## Frame of mind: this is a coordination schema, not a CRUD schema

A CRUD schema models *what exists*. A coordination schema models *what is happening* — which work is pending, which is in-flight, which has failed, who owns what right now, and what should happen next when a process dies.

This changes how you read the tables:

- **Every row is a state machine.** A `jobs` row is not a record of a job; it is the current state of a job's coordination. `status`, `current_worker_id`, `lease_expires_at`, `next_retry_at` together define what a worker is allowed to do with this row next.
- **Every column on the hot path is part of a predicate.** `scheduled_for` exists so dequeue can ask "is this job visible yet?". `lease_expires_at` exists so dequeue can ask "did the previous holder die?". Columns are not stored for display; they are stored because some decision is made against them.
- **The schema enforces invariants that the application would otherwise have to guess at.** A `CHECK` constraint that ties `status = 'running'` to `current_worker_id IS NOT NULL` means a bug that nulls out the worker without changing the state is rejected at write time, not discovered at 3am.
- **Time is a coordinate, not a label.** `enqueued_at` is a fact about the past; `scheduled_for`, `lease_expires_at`, and `next_retry_at` are *commitments to the future* that the dequeue query reads to decide what to do *now*. Confusing the two is how queues silently break.

The rest of this document is consistently arranged around this frame. Where a column could be a CRUD-style "for display," it is named and justified by the coordination decision it participates in.

## Scope

Queue coordination tables: **`jobs`**, **`job_attempts`**, **`workers`**.

Auth (ADR-0008) adds **`users`**, **`sessions`**, and **`api_keys`**. Those
tables are not part of queue correctness; they gate who may call the HTTP API.
See migrations `000003` / `000004` and `apps/api/internal/auth/`.

Intentionally **not** in scope for this document or its migrations:

- A `queues` table. Queues in MVP are string labels on `jobs.queue`. Per-queue concurrency limits, rate limits, and pause/drain are deferred — see [Future tables, intentionally deferred](#future-tables-intentionally-deferred).
- A `handlers` registry. Handlers are string labels on `jobs.handler` and `workers.handlers[]`. Validation lives in code.
- Organizations, users, tenants, full RBAC, billing, teams, audit log. API-key scopes are the only authorization unit today.

If we add any of those later, they will be additive — they will not change the meaning of the queue tables here.

## `jobs` — the coordination table

`jobs` is the heart of the system. Every other table either references it or describes processes that act on it. If you understand one table in Veyra, understand this one.

A row in `jobs` represents the lifetime of a unit of work. It is created on `Enqueue`, mutated through `Dequeue`/`Ack`/`Nack`/`Cancel`, and reaches a terminal state (`succeeded`, `dead_lettered`, or `cancelled`) where it remains for inspection until it is archived or purged (purge policy: deferred).

### Columns and why they exist

#### Identity

- **`id` — `TEXT`, primary key, ULID (Crockford base32, 26 chars).**
  Job IDs are ULIDs because they are k-sortable: appended to an index, they cluster by insertion time, which means "scan the last N jobs" is cheap. They are also recognizable in logs and the operator UI (`01HRX7K9P3FN8YBE7`). We do *not* use a `BIGSERIAL` because IDs are exposed externally (in URLs, in webhook payloads) and a guessable integer is a footgun. We do not use `UUIDv4` because it does not sort. Stored as `TEXT` for MVP simplicity; a future migration may switch to a 16-byte binary column if index size becomes a concern.

- **`handler` — `TEXT NOT NULL`.**
  The handler name decides *what code runs*. The dequeue query filters by handler. A worker passes the handlers it can run as a query parameter (SPEC §1.2), never as a JOIN against `workers`. Cardinality is low (tens of handlers, not thousands), so `TEXT` is fine. The partial index `(queue, handler, priority DESC, scheduled_for ASC) WHERE status='queued'` is the index behind that filter.

- **`queue` — `TEXT NOT NULL`.**
  The queue name decides *which worker pool* will pick the job up. Workers subscribe to a set of queues; dequeue is per-queue-subset. Same cardinality rationale as `handler`. A `queues` table would normalize this but adds a join to every dequeue — we accept denormalization here.

- **`priority` — `SMALLINT NOT NULL DEFAULT 5`, `CHECK (priority BETWEEN 0 AND 9)`.**
  Higher = sooner. Single digit so ordering in the dequeue ORDER BY is cheap and operators can reason about it ("priority 9 means urgent, default is 5"). Continuous priority (floats) would invite endless tweaking; a 0–9 scale forces operators to be intentional.

- **`idempotency_key` — `TEXT NULL`.**
  When set, prevents duplicate enqueues. Uniqueness is scoped to `(queue, idempotency_key)` via a partial unique index — see [Indexes](#indexes). The key is permanent: once a job has been enqueued with a key, that key in that queue is taken forever, even after the job succeeds. This is the simplest semantic; "key released on success" is a future option that requires an ADR because it changes the contract.

#### Body

- **`payload` — `JSONB NOT NULL`.**
  The handler's input. `JSONB` because handlers need to read fields out of it (logging, debugging, the operator UI); we are not just shipping opaque bytes. A 256 KiB size cap is planned but not enforced yet (SPEC §0.9); the column itself has no DDL-level cap because `TOAST` handles large values silently and we don't want a hard failure mode that varies with payload shape.

- **`result` — `JSONB NULL`.**
  Populated on success. Optional — handlers without a meaningful result leave this null. Same `JSONB` rationale as `payload`.

- **`error` — `JSONB NULL`.**
  Populated on failure. Shape: `{class, message, stack_trace, occurred_at}`. Stored as `JSONB` rather than separate columns because (a) it travels as a unit, (b) it is rarely queried by sub-field on the hot path, and (c) the stack trace is unbounded text that we don't want flattened into a column for every job. The shape matches `JobError` in the frontend's frozen vocabulary.

#### Retry policy

- **`attempt` — `INT NOT NULL DEFAULT 0`, `CHECK (attempt >= 0 AND attempt <= max_attempts)`.**
  Count of attempts already started (not completed). Incremented inside the dequeue UPDATE. Denormalized from `COUNT(*)` over `job_attempts` because the dequeue path must not pay for an aggregate.

- **`max_attempts` — `INT NOT NULL DEFAULT 3`, `CHECK (max_attempts >= 1)`.**
  Per-job retry ceiling. Per-job, not per-queue, because operators may want to set a one-off job to a different ceiling without touching queue defaults. Queue defaults live in code config for MVP; the value here is whatever the enqueuer chose.

- **`backoff` — `JSONB NOT NULL`.**
  Encoded backoff strategy. Shape matches `BackoffStrategy` in the frontend: `{kind: "exponential", base_seconds, cap_seconds}` or `{kind: "fixed", seconds}`. JSONB rather than columns because (a) the strategy is opaque to the schema (only the retry layer interprets it), (b) we want room to add strategy kinds without a migration, and (c) it travels as a unit.

#### Timestamps — the coordination clock

All timestamps are `TIMESTAMPTZ` (UTC under the hood, timezone-aware). Workers never write timestamps from their local clock; the database's `now()` is the single source of time. See [Time and clocks](#time-and-clocks).

- **`enqueued_at` — `TIMESTAMPTZ NOT NULL DEFAULT now()`.**
  Set once at insertion. Never updated. The "this job exists" moment.

- **`scheduled_for` — `TIMESTAMPTZ NOT NULL DEFAULT now()`.**
  The earliest moment this job becomes a candidate for dequeue. *Always* set — for an immediately-runnable job, it equals `enqueued_at`. The dequeue WHERE clause includes `scheduled_for <= now()`; if we let this be nullable we'd have to write `(scheduled_for IS NULL OR scheduled_for <= now())` on every dequeue, which is a worse predicate. (Note: the system-overview ADR-era draft called this `visible_at`. `scheduled_for` won because it matches the frontend's frozen field name and reads as a future commitment rather than a flag.)

- **`started_at` — `TIMESTAMPTZ NULL`.**
  When the *first* attempt began. Set on the dequeue that creates attempt 1, never overwritten on later attempts — per-attempt start times live on `job_attempts`. This column exists so operators can see "how long has this job been around vs how long has it been running."

- **`completed_at` — `TIMESTAMPTZ NULL`.**
  Set when status transitions to `succeeded`. Terminal.

- **`cancelled_at` — `TIMESTAMPTZ NULL`.**
  Set when status transitions to `cancelled`. Terminal.

- **`dead_lettered_at` — `TIMESTAMPTZ NULL`.**
  Set when status transitions to `dead_lettered`. Terminal.

Why three terminal timestamps instead of one `terminal_at` plus the status? Because the operator UI shows them as distinct fields and the storage cost is three nullable timestamps per row. Cheaper to store than to recompute "when did this become terminal" from `status` + a single timestamp.

#### Lease and retry coordinates

These four columns are the live coordination state. The dequeue query reads them; `Ack`/`Nack`/`Heartbeat`/`Cancel` mutate them.

- **`current_worker_id` — `TEXT NULL`, references `workers(id)` *informally* (no FK — see below).**
  The worker currently holding the lease. NULL when no worker holds the job. Why no formal foreign key? Two reasons. First, we want a worker row to be deletable (e.g. operator cleanup) without cascading havoc on historical jobs. Second, the relationship is observed through *behavior* (the worker heartbeats, holds leases) rather than referential integrity. The job_attempts row carries the historical record; this column is current-state only.

- **`lease_expires_at` — `TIMESTAMPTZ NULL`.**
  When the lease becomes reclaimable. NULL exactly when `current_worker_id IS NULL`. The dequeue query treats `status='running' AND lease_expires_at + 10s <= now()` as a reclaimable candidate; a worker's `RenewLease` extends this. See [The atomic dequeue](#the-atomic-dequeue) and [Lease lifecycle](#lease-lifecycle).

- **`next_retry_at` — `TIMESTAMPTZ NULL`.**
  When a failed job becomes a candidate for retry. Set on `Nack` (or on lease-loss). NULL for jobs in non-`failed` states. The retry scheduler promotes `status='failed' AND next_retry_at <= now()` rows back to `queued`. Dequeue never selects `failed` rows directly. Why not just put the job back in `queued` with a new `scheduled_for`? Because operators ask "what is currently failing?" and want a status that says so — not a status that says "queued, but for the third time." Distinguishing `queued` (never run, or running for the first time) from `failed` (last attempt failed, retry pending) is worth the extra state.

#### Status

- **`status` — `job_status NOT NULL DEFAULT 'queued'`.**

  The DB-level enum has **six** values:

  ```
  queued | running | succeeded | failed | dead_lettered | cancelled
  ```

  Note what is **not** in this list: `scheduled`. A scheduled (delayed) job is `status='queued'` with `scheduled_for > now()`. The frontend's frozen vocabulary surfaces `scheduled` as a separate status — that mapping is derived at the API layer. See [Status mapping: storage vs API](#status-mapping-storage-vs-api).

  Allowed transitions:

  ```
  queued       --dequeue-->   running
  running      --ack------>   succeeded     (terminal)
  running      --nack----->   failed
  running      --nack----->   dead_lettered (terminal, when attempt == max_attempts)
  running      --cancel--->   cancelled     (terminal)
  failed       --dequeue-->   running       (after next_retry_at)
  queued       --cancel--->   cancelled     (terminal, never ran)
  failed       --cancel--->   cancelled     (terminal)
  ```

  Transitions are enforced by the code paths that mutate `jobs`, not by a CHECK constraint, because expressing "old_status → new_status" requires knowing both, which a row-level CHECK does not. A `BEFORE UPDATE` trigger could enforce it; we defer that until we see a class of bug it would catch. Today the queue spec + a small set of well-named functions in the API are the enforcement.

#### Invariants (enforced as `CHECK` constraints)

- **Lease consistency.** `status='running'` if and only if `current_worker_id IS NOT NULL` and `lease_expires_at IS NOT NULL`. This catches "ack forgot to clear the lease" and "dequeue forgot to set the lease" — bugs that would otherwise be discovered as silently-stuck jobs.
- **Retry consistency.** `next_retry_at IS NOT NULL` implies `status='failed'`. A retry-pointer on a terminal job is a bug.
- **Attempt bounds.** `attempt >= 0 AND attempt <= max_attempts`. Off-by-one in the retry layer becomes a write failure, not a silently-over-retried job.
- **Terminal exclusivity.** At most one of `completed_at`, `cancelled_at`, `dead_lettered_at` is non-null, and exactly one is non-null when the status is the corresponding terminal status.

These are the constraints that turn classes of coordination bugs into transaction failures. They cost one CPU cycle per write. They are worth it.

## `job_attempts` — the audit log of work

`job_attempts` is the append-only history of every attempt at every job. One row per (job, attempt_number). Rows are inserted on dequeue and updated exactly once when the attempt ends.

This table exists for three reasons:

1. **The operator UI's "attempt history" view.** Each row in the frontend's attempt history table is a row here.
2. **Post-mortem.** When a job dead-letters, the operator wants to see what each attempt looked like — which worker, how long it ran, what the error was. Reconstructing that from `jobs` alone would require keeping the last error around forever, and would still miss the *previous* attempts' errors.
3. **The lease-loss path.** When dequeue reclaims a lease, the prior attempt's row gets its outcome stamped (`lease_lost`) before a new attempt row is inserted. This is how we distinguish "the worker said it failed" from "the worker disappeared mid-execution."

### Columns

- **`id` — `BIGSERIAL` primary key.** Internal-only; not exposed in URLs. Monotonic insertion order is useful for ordering attempts.
- **`job_id` — `TEXT NOT NULL`, `REFERENCES jobs(id) ON DELETE CASCADE`.** Hard FK with cascade. If a job row is purged, its history goes with it. (Purge policy is deferred; the cascade documents intent.)
- **`attempt_number` — `INT NOT NULL`.** Matches `jobs.attempt` at the moment this attempt started. `UNIQUE (job_id, attempt_number)` so we cannot insert a duplicate attempt row by mistake.
- **`worker_id` — `TEXT NOT NULL`.** Snapshot — *not* a FK to `workers`. We want this to survive a worker row being deleted. The cost of losing the worker → attempt linkage in the operator UI when a worker is deleted is small; the cost of cascading deletes through history is large.
- **`started_at` — `TIMESTAMPTZ NOT NULL`.** When the dequeue UPDATE committed.
- **`ended_at` — `TIMESTAMPTZ NULL`.** When the outcome was recorded. NULL while the attempt is in-flight. Together with `started_at`, this gives `duration_ms` (computed in the app, not stored as a generated column — keeping the schema portable across Postgres minor versions).
- **`outcome` — `attempt_outcome NULL`.** Enum: `succeeded | failed | timeout | cancelled | lease_lost`. NULL while in-flight. Matches the frontend's `AttemptOutcome`. The `timeout` outcome is distinct from `failed` because operators want to see "this handler is timing out" separately from "this handler is throwing"; the `lease_lost` outcome is distinct from both because it means *the worker* failed, not the handler.
- **`error_class`, `error_message` — `TEXT NULL`.** A flat copy of the most useful error fields for table display. The full structured error stays on `jobs.error` for the *latest* attempt; per-attempt errors are intentionally lossy (no stack trace per attempt) to keep this table small.

### What's not here

- No `payload`/`result` columns. Those live on `jobs` once, not per-attempt. An attempt does not change the payload, and only the final attempt's result matters.
- No `lease_expires_at`. The lease is current state, not history; it lives on `jobs`.

## `workers` — the roster

A `workers` row is the registration of a process that can execute jobs. Rows are inserted on worker startup, updated on heartbeat, and either updated on graceful shutdown or marked `disconnected` by a sweeper when heartbeats stop.

This table is intentionally **observational**, not authoritative. A worker that disappears without unregistering will sit here as `disconnected` until purged; that is fine — the dequeue's lease-expiry path does not need this table to reclaim work. The table exists for operator visibility, not for correctness.

### Why have it at all?

Several systems get away with no worker table, treating workers as ephemeral. We keep one because:

- **The operator UI needs it.** The frontend's `/workers` and `/workers/:id` views show workers, their capabilities, and their heartbeats. Reconstructing that from `jobs.current_worker_id` alone would only show workers that currently hold leases.
- **Capabilities are advertised for observability, not for execution coordination.** A worker stores its subscribed queues and supported handlers in `workers.queues` / `workers.handlers` so the operator UI can answer "what is this runtime capable of right now?" and "which runtimes can pick up handler X?". The dequeue path **does not read these columns.** Workers pass their capability set as query parameters on every dequeue call; the SQL filters with `WHERE queue = ANY($queues) AND handler = ANY($handlers)`. This is a load-bearing decision — see [What this schema deliberately does *not* do](#what-this-schema-deliberately-does-not-do). JOINing `workers` from the hot path would couple every dequeue to that table's locks, indexes, and write contention, and would silently defeat the entire reason we chose Postgres-as-a-queue.
- **Heartbeats need a home.** `last_heartbeat_at` and `heartbeat_interval_seconds` describe the worker's liveness contract. A sweeper compares these to `now()` to mark workers `disconnected`.

### Columns

- **`id` — `TEXT` primary key. Ephemeral per process boot.** Every worker process generates a fresh id (typically a ULID) at startup; two boots of the "same" logical worker produce *different* ids. This is load-bearing for crash-recovery correctness — see the next paragraph. The stable, operator-facing identity of a worker (the box, the deploy) is carried by `hostname` and `version`, not by `id`; the operator UI groups runtimes by hostname to track a machine across restarts.

  *Why ephemeral and not stable?* The lease guard pattern on `jobs` is `WHERE current_worker_id = $me AND status = 'running'`. If ids were reused across restarts, a freshly-booted process would inherit ownership of leases held by the previous (crashed) runtime. A `Heartbeat` from the new runtime would silently extend the dead runtime's lease, `Ack` could mark a job done that the new runtime never executed, and the dequeue's reclaim predicate (`lease_expires_at < now()`) would never fire because the heartbeat keeps refreshing it. Ephemeral ids make the guard pattern correctness-preserving without any extra fencing: a crashed runtime's id is simply gone, its leases age out naturally, and the dequeue reclaims them.
- **`hostname` — `TEXT NOT NULL`.** Where the process runs. Display + diagnostics.
- **`pid` — `INT NOT NULL`.** Process ID. Display + diagnostics.
- **`version` — `TEXT NOT NULL`.** Build version. Lets operators identify rolling deploys and stragglers.
- **`state` — `worker_state NOT NULL DEFAULT 'active'`.** Enum: `active | idle | draining | disconnected`. Why store rather than derive? Two reasons. First, "draining" is operator-set and has no underlying signal to derive from. Second, the dequeue path may want a quick "is this worker still valid" check without recomputing from heartbeat math. The sweeper that flips workers to `disconnected` runs on a low cadence; "active vs idle" is derivable from `EXISTS(SELECT 1 FROM jobs WHERE current_worker_id = …)` but is also denormalized here for the worker-list query.
- **`started_at` — `TIMESTAMPTZ NOT NULL DEFAULT now()`.** Insertion time.
- **`last_heartbeat_at` — `TIMESTAMPTZ NOT NULL DEFAULT now()`.** Updated on every heartbeat. The sweeper marks a worker `disconnected` when `now() - last_heartbeat_at > heartbeat_interval_seconds * 3`.
- **`heartbeat_interval_seconds` — `INT NOT NULL DEFAULT 5`.** The contract: "I will heartbeat at most every N seconds." The sweeper's threshold is `3 * N`, not `N`, to tolerate jitter.
- **`queues` — `TEXT[] NOT NULL`.** Subscribed queues.
- **`handlers` — `TEXT[] NOT NULL`.** Supported handlers.
- **`max_concurrency` — `INT NOT NULL`.** The worker's own concurrency cap. Advisory; the worker enforces it. Stored so operators can see expected capacity.
- **`total_processed` — `BIGINT NOT NULL DEFAULT 0`.** Lifetime job count. Worker-maintained; not authoritative (a crash will lose recent increments). Operator UI metric, not a billing source.

### What's not here

- **No `in_flight` column.** That number is `SELECT COUNT(*) FROM jobs WHERE current_worker_id = $1 AND status = 'running'`. Storing it would require updating two rows on every dequeue/ack, doubling the write amplification of the hot path. The count query hits a single indexed range and is cheap.
- **No `leases` column.** Same reasoning — leases are derived from `jobs`, not stored on `workers`.

## The atomic dequeue

This is the query that everything turns on. It must:

1. Find one runnable job a single worker has not been handed yet.
2. Mark it as held by that worker, with a fresh lease.
3. Increment its attempt counter.
4. Insert a `job_attempts` row for the new attempt.
5. If reclaiming a lease-lost job, close out the previous `job_attempts` row.
6. Do all of the above in a single transaction, without blocking other workers.

The mechanism is `SELECT ... FOR UPDATE SKIP LOCKED`, which is what makes Postgres-as-a-queue work. ADR-0002 names this as the reason we chose Postgres at all.

### What "runnable" means

A job is runnable for a worker if **all** of the following hold:

- `jobs.queue` is in the worker's subscribed queues, and `jobs.handler` is one the worker runs (SPEC §1.2).
- One of these state predicates is true:
  - `status = 'queued' AND scheduled_for <= now()`: first attempt, visible.
  - `status = 'running' AND lease_expires_at + 10s <= now()`: the previous holder is gone, so reclaim.

Failed rows are not runnable. The retry scheduler moves them back to `queued` when `next_retry_at` is due.

The worker's subscribed queues arrive as a query parameter (`= ANY($queues)`), never via a JOIN against `workers`. The `workers.queues[]` and `workers.handlers[]` columns exist for the operator UI. The dequeue path does not read them.

### Ordering

`ORDER BY priority DESC, scheduled_for ASC`. Highest priority first; among equal priority, oldest visibility first. This must match the partial index on the same expression — see [Indexes](#indexes).

### Lock discipline

`FOR UPDATE SKIP LOCKED LIMIT 1` ensures:

- Each worker takes a row that no other worker is currently looking at.
- Workers do not block each other — there is no contention queue.
- A worker that crashes between `SELECT` and `UPDATE` releases its lock on transaction abort; the row becomes available to the next dequeue.

### The reclaim case

When the claim picks up a `status='running'` row whose lease has expired (plus the 10-second grace), the reclaim primitive runs in the same transaction (SPEC §5):

1. The open `job_attempts` row for the prior attempt is closed with `outcome='lease_lost'` and `ended_at = now()`. The `ended_at IS NULL` guard prevents closing an attempt twice.
2. If budget remains, the claim proceeds under the new worker. `jobs.attempt` increments and a new `job_attempts` row is inserted.
3. If the budget is exhausted, the row goes to `dead_lettered` and the claim returns nothing.

The periodic tick in the API takes the same expired rows and requeues them to `queued`. It does **not** increment `attempt`, and it does not touch `next_retry_at`.

The whole operation is one transaction. If the process dies mid-transaction, the abort leaves the job as it was, and a future claim picks it up again.

## Lease lifecycle

A lease is a promise: *this worker will heartbeat by `lease_expires_at`, or the job is reclaimable.*

- **Acquire.** Dequeue sets `current_worker_id` and `lease_expires_at = now() + 30 seconds`. The duration is a constant in code (SPEC §1.8). A future change may make it per-job.
- **Extend (renew).** The worker calls `RenewLease` every 10 seconds per in-flight job (SPEC §4). It runs `UPDATE jobs SET lease_expires_at = now() + 30 seconds WHERE id = $1 AND current_worker_id = $2 AND status = 'running'`. The `current_worker_id = $2` check is critical: if the lease was already reclaimed by another worker, the UPDATE affects zero rows and the worker knows to stop.
- **Release on success (`Ack`).** `UPDATE jobs SET status='succeeded', completed_at=now(), result=$2, current_worker_id=NULL, lease_expires_at=NULL WHERE id=$1 AND current_worker_id=$3 AND status='running'`. Same lease-still-mine guard.
- **Release on failure (`Nack`).** If `attempt < max_attempts`: `status='failed'`, `error=$2`, `current_worker_id=NULL`, `lease_expires_at=NULL`, `next_retry_at` = now() plus a jittered backoff delay (SPEC §3.5). If `attempt = max_attempts`: `status='dead_lettered'`, `dead_lettered_at=now()`, rest as above.
- **Reclaim.** Two call sites run the same queue-core primitive: inline in dequeue, and a periodic tick in the API (`apps/api/internal/reclaim/`). The lease's expiration is the signal (SPEC §5).
- **Cancel.** Operator-initiated (normative: `packages/queue-core/SPEC.md` §6). Transitions `queued` / `failed` / `running` → `cancelled`, sets `cancelled_at`, clears `next_retry_at` and lease ownership. For `running`, also closes the open `job_attempts` row with `outcome='cancelled'`. Already-`cancelled` is idempotent; `succeeded` / `dead_lettered` reject. Cooperative: worker discovers via failed lease renewal and must not Ack/Nack.

The guard pattern on every mutation — "this row's lease must still be mine" — is what makes the system safe under partition. A worker that thinks it's running a job but has been silently reclaimed cannot ack it; the ack will affect zero rows and the worker will log and bail.

## Retry and dead-letter

`Nack` computes `next_retry_at` from `jobs.backoff` inside queue-core (SPEC §3.5). The retry scheduler in `apps/api/internal/retries/` promotes due rows back to `queued`. The schema's role is narrow:

- `attempt` and `max_attempts` are the ceiling.
- `backoff` is the policy.
- `next_retry_at` is the commitment.
- `status='failed' AND next_retry_at <= now()` is the scheduler's promotion predicate.

Dead-letter is a status transition, not a separate table. A dead-lettered job stays in `jobs` so the operator UI can show it next to its retries; "move to a DLQ table" would scatter the same information across two tables. Replay from dead-letter is **not implemented yet**. When it lands, it will be an operator-initiated, audited state change. The shape is likely `UPDATE jobs SET status='queued', error=NULL, next_retry_at=NULL, dead_lettered_at=NULL`. Changing `attempt` on replay is a spec decision, to be made when the operation is specified.

## Cancellation

Normative semantics: `packages/queue-core/SPEC.md` §6.

A job can be cancelled from `queued`, `failed` (retry-pending), or `running`. Re-cancel of an already-`cancelled` job is idempotent. `succeeded` and `dead_lettered` reject. On `running`, Cancel itself closes the open attempt with `outcome='cancelled'` and clears the lease; the worker discovers the loss on renew and abandons without Ack/Nack.

Cancellation is **cooperative**, not preemptive. Preemptive kill requires a side channel we do not have in v1.

## Status mapping: storage vs API

The DB stores six statuses. The frontend (and therefore the API) surfaces seven. The seventh — `scheduled` — is derived:

- `status_api = 'scheduled'` when `status='queued' AND scheduled_for > now()`.
- Otherwise `status_api = status` (with the trivial rename `dead_lettered → 'dead-lettered'`).

This mapping happens in the API's serializer, not the schema. It exists for one reason: the operator UI wants to distinguish "queued and waiting for a worker" from "queued but not yet visible." That distinction is meaningful to humans; it is not meaningful to the dequeue query (which simply checks `scheduled_for <= now()`).

If a future requirement makes `scheduled` a first-class storage concern (e.g. a separate dequeue path for delayed jobs that scans a smaller index), we will add the column and back it with a migration. Until then, derivation is correct and cheaper.

## Indexes

The dequeue query is read tens to thousands of times per second. Every other query is cold by comparison. Index design is dominated by dequeue.

The single most important index is a **partial index** on the runnable predicate:

```
CREATE INDEX idx_jobs_runnable
  ON jobs (queue, handler, priority DESC, scheduled_for ASC)
  WHERE status = 'queued';
```

Plus a sibling for retry-pending:

```
CREATE INDEX idx_jobs_retry_pending
  ON jobs (queue, handler, priority DESC, next_retry_at ASC)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;
```

Plus one for expired-lease reclaim (smaller, since `status='running'` is the live set):

```
CREATE INDEX idx_jobs_lease_expired
  ON jobs (lease_expires_at)
  WHERE status = 'running';
```

Why partial indexes? Because the queue's hot path only cares about a tiny fraction of `jobs` — the runnable subset. A full index would include `succeeded` and `dead_lettered` rows that are never matched by the dequeue WHERE clause; that's bloat that slows every insert and never helps a read. Partial indexes are the canonical Postgres-as-queue technique.

Additionally:

- **`jobs (id)`** — primary key, automatic.
- **`jobs (status, completed_at DESC)`** — for the operator UI's "recently succeeded" list. Tunable later.
- **`jobs (current_worker_id) WHERE status = 'running'`** — for "what is this worker doing" lookups.
- **`UNIQUE jobs (queue, idempotency_key) WHERE idempotency_key IS NOT NULL`** — idempotency enforcement.
- **`job_attempts (job_id, attempt_number)`** — unique, drives the per-job history view.
- **`job_attempts (worker_id, started_at DESC)`** — for "what has this worker been doing" lookups.
- **`workers (last_heartbeat_at) WHERE state IN ('active','idle')`** — the sweeper's scan.

Vacuum tuning on `jobs` will need to be aggressive — high churn (insert, several updates, eventual delete) on a hot table is the case `autovacuum` defaults are not tuned for. Specifics belong in an operational runbook, not here.

## Time and clocks

Three rules:

1. **All timestamps are written by the database, not by clients.** `DEFAULT now()` on insert; `SET lease_expires_at = now() + ...` on update. Workers and the API service do not pass timestamps in; they read them out.
2. **Comparisons use `now()` evaluated by the database** in the same statement as the write. This avoids skew between application and database clocks. A worker whose clock is 30 seconds ahead does not get to reclaim leases early.
3. **All columns are `TIMESTAMPTZ`.** Internally Postgres stores UTC; the timezone tag prevents the "wait, was that local time or UTC?" class of mistake on read.

`clock_timestamp()` vs `now()` (`transaction_timestamp()`): within a fast dequeue transaction the difference is microseconds. We use `now()` throughout for consistency; if a future profile shows transaction-start-vs-real-time drift mattering for a specific operation, that's a localized switch.

## What this schema deliberately does *not* do

Documenting absences makes future contributors' decisions easier:

- **No JOIN against `workers` on the dequeue path.** Capability filtering (queue/handler subscription) happens by query parameters that the worker passes on every dequeue call, *not* by reading `workers.queues[]` or `workers.handlers[]`. The columns on `workers` exist for the operator UI. If a future change introduces a JOIN from the hot path to `workers`, every dequeue starts paying for that table's locks, indexes, and write contention — which silently undoes the entire premise of Postgres-as-a-queue. Treat any PR that adds `JOIN workers` inside `packages/queue-core/` as a spec violation until an ADR justifies it.
- **No `LISTEN`/`NOTIFY` on the worker dequeue path.** Workers poll. The dequeue query is fast enough that polling at ~1s cadence is fine. Promoting LISTEN into the worker loop would be a separate ADR + SPEC change.
- **Operator UI does use `LISTEN`/`NOTIFY`.** Statement-level triggers on `jobs` / `workers` notify channel `veyra_ui`; the API fans that out over SSE (`GET /events`). See [ADR-0009](../decisions/0009_operator-live-updates-sse.md). This does not change queue semantics.
- **No separate dead-letter table.** Status transition only.
- **No event log / outbox.** ADR-0002 explicitly rules out dual writes. If we later need to publish job state changes to an external system, that comes via an additive table and a polling cursor, with its own ADR.
- **No row-level row versioning (`xmin`-based optimistic locking).** The "lease must still be mine" guards on UPDATEs serve the same purpose with clearer semantics.
- **No triggers** for status transition enforcement. Application code in the queue layer is the choke point; triggers add a second place to look when transitions are wrong.
- **No partitioning.** Until we have a measured reason (table size, vacuum pain, retention policy), partitioning is premature complexity.

## Future tables, intentionally deferred

These will land later, each behind its own migration and (where the contract changes) its own ADR:

- **`queues`** — once we need per-queue concurrency limits, pause/drain, rate limits, or default-attempts overrides as stored config rather than code config.
- **`schedules`** — for recurring jobs (cron-style). MVP supports one-shot scheduled jobs only, via `scheduled_for`.
- **`audit_log`** — for operator actions (pause, drain, replay, cancel). Today those happen, but only the resulting state change is recorded.
- **`archived_jobs`** — when retention pressure on `jobs` forces a separation between hot (last N days) and cold (everything else). The shape will mirror `jobs`.

## Open questions

These are unresolved and will need decisions before — or shortly after — first production traffic:

- **Idempotency key release on success.** Currently permanent. Some users will want "once succeeded, the key is reusable." Requires a contract change.
- **Hard size limits on `payload` / `result` / `error`.** Not enforced yet. The planned cap is 256 KiB, in code rather than in DDL. A DDL-level CHECK is simple but blunt. Open.
- **Retention.** `succeeded` jobs accumulate. A purge job has to land before the table grows past comfortable working-set size. Open: how long, and is purge or archive the right move?
- **Per-job lease duration.** Currently a fixed 30-second constant. Some long-running handlers want longer leases without changing queue-wide config. Adding `jobs.lease_duration_seconds` is trivial; the question is whether the spec should grow per-job knobs.

These belong in ADRs or spec revisions as they get answered, not in this document.
