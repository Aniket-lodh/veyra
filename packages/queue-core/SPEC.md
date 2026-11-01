# Queue semantics — authoritative spec

This file is the source of truth for Veyra's queue behavior. The implementation
in `packages/queue-core/`, the API (`apps/api/internal/{jobs,retries,reclaim}/`), the
worker, and the operator console all reason about jobs based on what is written here. **If the spec
and the code disagree, the spec is right and the code is the bug.**

The rule: any change to the operations listed below must update this document
first, then update implementation, then add a test that names the spec section
it verifies. See
[`docs/decisions/0004_queue-semantics-documented-before-implementation.md`](../../docs/decisions/0004_queue-semantics-documented-before-implementation.md).

## Operations

| Operation         | Section                                                            | Status        |
|-------------------|--------------------------------------------------------------------|---------------|
| **Enqueue**       | [§0 Enqueue](#0-enqueue)                                           | implemented   |
| **Dequeue**       | [§1 Dequeue](#1-dequeue)                                           | implemented   |
| **Ack**           | [§2 Ack](#2-ack-success-completion)                                | implemented   |
| **Nack / Fail**   | [§3 Nack](#3-nack-failure-completion)                              | implemented   |
| **Retry scheduling** | [§3.5 Retry scheduling](#35-retry-scheduling)                   | implemented   |
| **Lease Renewal** (a.k.a. ExtendLease) | [§4 Lease Renewal](#4-lease-renewal)          | implemented   |
| Worker heartbeat  | out of scope — proves the *runtime process* is alive, not a specific job execution. Lives in the `workers` table; see `apps/worker/CLAUDE.md`. Do **not** conflate with Lease Renewal. | n/a |
| **Cancel**        | [§6 Cancel](#6-cancel)                                             | implemented   |
| **Timeout / Reclaim** | [§5 Reclaim](#5-reclaim) — a top-level primitive with multiple invocation sites (dequeue inline + api-side periodic tick) | implemented   |
| **Failure classification** (retryable vs permanent) | [§7 Failure classification](#7-failure-classification--retryable-vs-permanent) | implemented   |

A "not yet written" section is a hole, not a license to invent semantics. Stop
and add the section first.

**Test coverage is tracked per section.** Where a section lists no test, the
behavior is implemented but not yet covered by an automated test. Those gaps are
listed in each section's *Verified by* block. Do not claim coverage that is not
listed there.

---

## 0. Enqueue

Enqueue creates a job in the `queued` state. It is the only operation that
inserts a row into `jobs`.

The implementation is `Repository.Create(ctx, CreateParams)` in
`packages/queue-core/repository.go`. The HTTP entry point is `POST /jobs` in
`apps/api/internal/jobs/handler.go`, which validates the request and builds the
params.

### 0.1 Inputs

| Name             | Type        | Required | Default       | Constraints |
|------------------|-------------|----------|---------------|-------------|
| `handler`        | `string`    | yes      | —             | Trimmed, non-empty. Not checked against any registry: the API does not know which handlers workers run. |
| `queue`          | `string`    | yes      | —             | Trimmed, non-empty. |
| `payload`        | JSON        | yes      | —             | Must be valid JSON. No size cap is enforced yet (see §0.9). |
| `priority`       | `int`       | no       | `5`           | `0`–`9`, higher runs first. |
| `maxAttempts`    | `int`       | no       | `3`           | `>= 1`. |
| `backoff`        | object      | no       | exponential, base 30s, cap 3600s | Validated by `BackoffStrategy.Validate`. |
| `scheduledFor`   | timestamp   | no       | `now()`       | Database time. A future value makes the job invisible to dequeue until then. |
| `idempotencyKey` | `string`    | no       | none          | Trimmed. An empty value is treated as absent. See §0.5. |

### 0.2 Outputs

The inserted row as a `Job`. The HTTP API returns it with status `201`. The API
reports `status: "scheduled"` when the row is `queued` and `scheduledFor` is in
the future (see `docs/architecture/database-schema.md`, "Status mapping").

### 0.3 Preconditions

- Input validation passed (§0.1). Validation runs in the API layer. Queue-core
  does not re-validate `handler`, `queue`, or `priority`.

### 0.4 Postconditions (success)

- A new row exists with a fresh ULID `id`, `status = 'queued'`, `attempt = 0`,
  `enqueued_at = now()`, and `scheduled_for` as given or `now()`.
- `current_worker_id`, `lease_expires_at`, `next_retry_at`, and the terminal
  timestamps are `NULL`.

### 0.5 Idempotency

When `idempotencyKey` is set, `(queue, idempotency_key)` is unique for the life
of the row. A second `Create` with the same pair returns the **existing** job
and inserts nothing. The API still answers `201`, so callers do not need to
tell first-time and repeat enqueues apart. The new request's other fields are
ignored. A key is never released, even after the job succeeds.

### 0.6 Concurrency

The insert is `INSERT ... ON CONFLICT (queue, idempotency_key) WHERE
idempotency_key IS NOT NULL DO NOTHING RETURNING ...`. If the insert hits a
conflict, the existing row is read back by key. Two concurrent creates with the
same key resolve to one row.

### 0.7 Ordering and visibility

- A job becomes visible to dequeue when `scheduled_for <= now()` (§1.2).
- Among visible jobs, dequeue orders by `priority DESC, scheduled_for ASC` (§1.3).
- The job list (`GET /jobs`) orders by `enqueued_at DESC`.

### 0.8 Errors

Queue-core returns no sentinel errors for Create. Validation failures are
returned by the API as `400` before queue-core is called. Database errors are
wrapped with the function name and returned, and the API maps them to `500`.

### 0.9 Known gaps

- The payload size cap (256 KiB, described in `docs/architecture/database-schema.md`)
  is not enforced yet.
- Queue-core emits no event on enqueue. The API logs `jobs.create` with `jobId`,
  `queue`, `handler`, `priority`, and `maxAttempts`.

### 0.10 Verified by

No automated test covers Create yet. The end-to-end paths are exercised only
manually and through the operator scripts in `scripts/stress/`.

---

## 1. Dequeue

Dequeue is the atomic operation by which a worker takes ownership of one job
for execution. It is the hot path of the entire system.

The implementation is `Repository.ClaimNextJob(ctx, workerID, queues)` in
`packages/queue-core/repository.go`. The worker calls it on every poll. The
debug route `POST /internal/debug/claim` calls the same method.

*Verified by:*

- `TestClaim_FiltersByHandler`: a worker claims only jobs whose handler is in its list.
- `TestClaim_RequiresQueuesAndHandlers`: empty `queues` or `handlers` is rejected before SQL.
- `TestClaim_InlineReclaimRespectsHandler`: an expired lease for a handler the caller does not run is not reclaimed inline. The tick driver still reclaims it (§5.5.2).
- `TestReclaim_FleetCollapse_SelfHeals` (`packages/queue-core/reclaim_integration_test.go`) claims jobs through this path end to end.

**Compatibility.** `ClaimNextJob` gains a `handlers` parameter. The worker, the
debug claim route (`POST /internal/debug/claim`, which now requires `handlers`),
and the tests all change in the same commit. Deploy the API and workers together.

### 1.1 Inputs

| Name      | Type     | Meaning                                                          |
|-----------|----------|------------------------------------------------------------------|
| `workerID`| `string` | The **runtime** id of the calling worker (ephemeral per process boot — see `docs/architecture/database-schema.md`, "Worker identity", or simply: "fresh ULID each start"). Stored on the row as `current_worker_id` and on the new attempt row as `worker_id`. |
| `queues`  | `[]string` | The set of queue names the worker is subscribed to. The worker passes this on **every** call. Must be non-empty. |
| `handlers`| `[]string` | The set of handler names the worker can run. The worker passes this on **every** call. Must be non-empty. A job whose `handler` is not in this set is never returned to this caller. |

Both `queues` and `handlers` are filters on the claim. A job is returned only if
its `queue` is in `queues` and its `handler` is in `handlers`. This is the rule
from SPEC §1.2 and it applies to every candidate, including reclaim candidates
(§5.1).

### 1.2 Selection predicate

A row is **runnable** by this worker if **all** of the following hold:

1. `queue = ANY($queues)` — the caller is subscribed to this queue.
2. `handler = ANY($handlers)` — the caller can run this handler.
3. One of these state predicates is true:
   - `status = 'queued' AND scheduled_for <= now()` — a fresh, visible job.
   - `status = 'running' AND lease_expires_at + reclaim_grace <= now()` —
     a reclaimable job whose previous lease has expired AND whose grace
     window has elapsed. Dequeue invokes the [§5 Reclaim](#5-reclaim)
     primitive inline within its FOR UPDATE transaction to adopt the
     row. See [§5.10 Parameters](#510-parameters) for `reclaim_grace`'s
     definition and rationale.

Failed jobs (`status='failed'`) are **not** considered here. They re-enter the
runnable set only after the retries module transitions them back to `queued`.
That transition is out of scope for Dequeue.

`workers.queues[]` and `workers.handlers[]` are **not** consulted. The dequeue
hot path never reads or joins the `workers` table — capability is a parameter,
not a row. See `docs/architecture/database-schema.md`, "What this schema deliberately does not do", for the why.

### 1.3 Ordering

Among runnable rows, the candidate is chosen by

```sql
ORDER BY priority DESC, scheduled_for ASC
LIMIT 1
```

Priority is a fixed range `[0, 9]`, higher wins. Ties break by oldest
`scheduled_for` first — both for fresh queued jobs (oldest delivery wins) and
for reclaim candidates (oldest scheduling intent wins). `enqueued_at` is **not**
a tiebreaker because `scheduled_for` already encodes intended visibility.

### 1.4 Locking discipline

The candidate row is selected with

```sql
SELECT ... FROM jobs
WHERE <predicate>
ORDER BY ...
LIMIT 1
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE` takes a row-level write lock. `SKIP LOCKED` makes concurrent
dequeue workers each pick a different row instead of blocking on the same
candidate. This is the canonical Postgres-as-queue concurrency pattern; no
advisory locks, no application-level coordination.

The lock is released when the surrounding transaction commits or rolls back.

The entire Dequeue is one transaction: SELECT (lock) → optional UPDATE on the
old `job_attempts` row → UPDATE jobs → INSERT job_attempts → COMMIT. If any
step fails, the whole claim is rolled back and the job remains available.

### 1.5 Reclaim of expired leases

If the selected candidate has `status='running'`, this is a **reclaim**: the
prior owner is dead or stuck and the row is being adopted. Dequeue does not
implement reclaim itself — it invokes the [§5 Reclaim](#5-reclaim) primitive
within its FOR UPDATE transaction.

The primitive closes the prior attempt and, based on attempt budget, either
(a) leaves the row reclaimable so Dequeue's continuation can claim it under
the new worker, or (b) dead-letters in place. Specifically:

- **Budget remaining** ([§5.5.1](#551-mode--inlineclaim-dequeue)): the
  primitive closes the prior attempt; Dequeue then performs the claim update
  ([§1.6](#16-claim-update)) and inserts the new attempt row
  ([§1.7](#17-attempt-history)). Dequeue returns the claimed `*Job`.
- **Budget exhausted** ([§5.6](#56-effects--budget-exhausted-branch-attempt--max_attempts)):
  the primitive dead-letters the row in place. Dequeue returns `(nil, nil)`
  and the caller polls again. This DLQ side-effect is bonus work Dequeue
  performs to keep the queue from accumulating doomed-but-runnable rows.

All semantics — attempt accounting, constraint reasoning, locking, the
"previous owner cannot silently complete" guarantee, and the observability
contract — live in §5 and MUST NOT be redocumented here. Implementations
that need to know what reclaim does read §5; this section's only job is to
describe how Dequeue is *composed* with the primitive.

### 1.6 Claim update

This section applies to fresh-queued candidates and to reclaims where
budget remains (§5.5.1, the `InlineClaim` mode of the reclaim primitive).
It does **not** apply to the §5.6 budget-exhausted branch, which writes
a terminal DLQ update instead.

The `jobs` row is updated:

| Column              | New value                                            |
|---------------------|------------------------------------------------------|
| `status`            | `'running'`                                          |
| `current_worker_id` | `$workerID`                                          |
| `lease_expires_at`  | `now() + interval '30 seconds'` (lease duration, [§1.8](#18-lease-duration)) |
| `attempt`           | `attempt + 1`                                        |
| `started_at`        | `COALESCE(started_at, now())` — set on first claim only; preserved across reclaims |

All other columns (`payload`, `priority`, `backoff`, `max_attempts`,
`enqueued_at`, `scheduled_for`, `idempotency_key`, …) are untouched. The
returned row is the post-update state, scanned through the standard
`scanJob` helper so the caller receives a fully populated `*Job`.

The `jobs_lease_consistency` CHECK constraint is satisfied by the simultaneous
write of `status='running'`, non-NULL `current_worker_id`, and non-NULL
`lease_expires_at` in a single UPDATE statement.

`next_retry_at` must be NULL after a claim (the `jobs_retry_consistency`
constraint requires it for non-`failed` rows). It is already NULL for runnable
candidates: fresh `queued` rows never had it set, and reclaim candidates were
`running` (not `failed`), so it was NULL there too.

### 1.7 Attempt history

After the claim UPDATE returns, a new row is inserted into `job_attempts`:

| Column            | Value                                            |
|-------------------|--------------------------------------------------|
| `job_id`          | the claimed job's id                             |
| `attempt_number`  | the **post-increment** `jobs.attempt` value      |
| `worker_id`       | `$workerID` (snapshot; no FK)                    |
| `started_at`      | `now()`                                          |
| `ended_at`, `outcome`, `error_class`, `error_message` | NULL — the attempt is in-flight |

The `(job_id, attempt_number)` UNIQUE index guarantees we cannot accidentally
insert two rows for the same attempt. If a second Dequeue races to the same
(impossibly, because of `FOR UPDATE`) job and tries to write the same
attempt_number, the second INSERT fails and the whole transaction rolls back.
The lock makes this a tautological safeguard, not a primary defense.

### 1.8 Lease duration

For now, hardcoded to **30 seconds**. The constant lives next to the SQL in
`repository.go`. Future iterations will:

- promote it to a per-job field (`jobs.lease_duration_seconds`?), and/or
- let the worker propose it on Dequeue and accept clamping by the server.

When that change lands, this section must be updated first.

### 1.9 No-candidate case

If the SELECT returns no row (the predicate matched nothing, or every match
was already locked by another concurrent dequeue), `ClaimNextJob` returns
`(nil, nil)` — not an error. Callers branch on `job == nil`. A "no work
available" log line is emitted at debug level; this is the steady state on an
idle queue and must not look like a failure.

### 1.9a Jobs with no capable worker

A job whose handler no live worker runs stays `queued` (or `running`, once
leased) until a worker that runs that handler claims it. Dequeue never fails a
job because its handler is unknown to the caller. There is no timeout on this
wait. Operators see such jobs as queued depth in `GET /queue/stats`, and they
can cancel them (§6).

Enqueue does not validate handler names against any worker's registry (§0.1).
A typo in `handler` therefore creates a job that waits here indefinitely.

`UnknownHandler` is no longer produced by the claim path. A worker that claims
a job it cannot run because of a race between its registry and its claim call
records it as `UnknownHandler` as a defensive fallback. No other path produces it.

### 1.10 Errors

- Empty `queues` or empty `handlers` slice → returned synchronously as a
  validation error, no SQL executed. A worker that can run nothing must not claim.
- Any pgx error during select/update/insert/commit → wrapped with the function
  name and returned. The transaction is rolled back via deferred `Rollback`
  (safe to call after Commit; pgx ignores "tx already closed").

There are no sentinel errors specific to Dequeue at this stage. `ErrLeaseLost`
and `ErrJobNotFound` are reserved for Heartbeat / Ack / Nack.

### 1.11 Observability contract

Every call MUST emit, at minimum:

| Event                | Level | Required fields                                                                 |
|----------------------|-------|---------------------------------------------------------------------------------|
| candidate found      | debug | `workerId`, `jobId`, `priorStatus`, `attemptBefore`, `wasReclaim`               |
| claim succeeded      | info  | `workerId`, `jobId`, `attempt`, `leaseExpiresAt`, `wasReclaim` (bool)           |
| no candidate         | debug | `workerId`, `queues`                                                            |

The reclaim sub-operations Dequeue performs (closing the prior attempt,
inline-claim, dead-letter on budget exhaustion) are NOT emitted from here;
they are emitted by the primitive itself, with `site=inline` to distinguish
them from tick-driven reclaims. See [§5.12](#512-observability-contract).
Do NOT re-emit the legacy `queue.dequeue.reclaim_closed_prior` /
`queue.dequeue.dlq_on_reclaim` names from this section — they are
superseded by the unified §5.12 names.

Additional fields beyond the required set are permitted — emit anything the
operator UI may benefit from.

Names are camelCase to match the frontend contract. The implementation uses
`log/slog`.

---

## 2. Ack (success completion)

Ack is how a worker reports that a job's current attempt finished successfully.
It is the only transition out of `running` into `succeeded`.

The implementation is `Repository.MarkJobSucceeded(ctx, SucceedParams)` in
`packages/queue-core/repository.go`. The worker calls it after a successful
handler run. The debug route `POST /internal/debug/succeed` calls the same method.

*Verified by:* no automated test for the success path yet (gap).

### 2.1 Inputs

| Name      | Type              | Meaning                                                |
|-----------|-------------------|--------------------------------------------------------|
| `workerID`| `string`          | The runtime id of the caller — must equal `jobs.current_worker_id` for the call to succeed. |
| `jobID`   | `string`          | The job whose current attempt is being acked.          |
| `result`  | `json.RawMessage` | Optional. Stored verbatim into `jobs.result` (JSONB) when non-empty; otherwise the column is set to NULL. The queue does not interpret it. |

### 2.2 Preconditions

All of the following must hold. The order below is the order in which the
implementation evaluates them, which determines which error is returned when
several would apply:

1. A row exists in `jobs` with `id = $jobID`. Otherwise → `ErrJobNotFound`.
2. That row's `status = 'running'` **and** `current_worker_id = $workerID`.
   Otherwise → `ErrLeaseLost`. This is the lease guard. It defends against
   a worker whose lease has already been reclaimed.
3. `lease_expires_at > now()`. Otherwise → `ErrLeaseExpired`. A worker whose
   lease has expired (even if not yet reclaimed) has forfeited its authority
   to write outcomes. The reclaim path will eventually pick this row up.

The comparison in (3) uses the database clock (`now()` in SQL), not the Go
process clock. Clock skew between worker and DB is observable but cannot
cause an incorrect Ack to be accepted.

### 2.3 Locking discipline

The call opens a transaction and takes `SELECT ... FOR UPDATE` on the
`jobs(id)` row — no `SKIP LOCKED`. We want callers to serialize, not skip:
two concurrent Acks for the same job must not both succeed.

The lock is held across the attempt-row close and the jobs-row update; both
writes commit atomically.

### 2.4 Effects

In one transaction:

1. The active attempt row (the unique row in `job_attempts` with
   `job_id = $jobID`, `attempt_number = jobs.attempt`, `ended_at IS NULL`)
   is closed:
   - `outcome = 'succeeded'`
   - `ended_at = now()`

2. The `jobs` row is updated:
   - `status = 'succeeded'`
   - `completed_at = now()`
   - `current_worker_id = NULL`
   - `lease_expires_at = NULL`
   - `result = $result` (or `NULL` when the caller passed an empty payload)

The simultaneous write of `status='succeeded'` + cleared lease coordinates
satisfies `jobs_lease_consistency`. The simultaneous write of
`completed_at` + `status='succeeded'` satisfies `jobs_terminal_exclusivity`.

### 2.5 Idempotency

Ack is **not** idempotent. A second call returns `ErrLeaseLost` because the
row is no longer in `status='running'`. A future revision may add a
request-id-based idempotency layer; until then, callers must treat Ack as
once-only.

### 2.6 Errors

| Sentinel             | Meaning                                                                                  |
|----------------------|------------------------------------------------------------------------------------------|
| `ErrJobNotFound`     | No `jobs` row with the given id.                                                         |
| `ErrLeaseLost`       | Status is not `running`, or `current_worker_id` does not match `$workerID`.              |
| `ErrLeaseExpired`    | The caller still owns the row, but `lease_expires_at <= now()`.                          |

Callers branch with `errors.Is`. Any other error is wrapped with the function
name and returned.

### 2.7 Observability contract

| Event                | Level | Required fields                                                                            |
|----------------------|-------|--------------------------------------------------------------------------------------------|
| guard failed         | warn  | `workerId`, `jobId`, `reason` (`not_found` / `lease_lost` / `lease_expired`)               |
| ack succeeded        | info  | `workerId`, `jobId`, `attempt`, `hadResult` (bool)                                         |

Names are camelCase. Implementation uses `log/slog`. Extra fields are permitted.

---

## 3. Nack (failure completion)

Nack is how a worker reports that a job's current attempt failed. It is the
only transition out of `running` into `failed` or `dead_lettered`.

The implementation is `Repository.MarkJobFailed(ctx, FailParams)` in
`packages/queue-core/repository.go`. The worker calls it after a failed handler
run. The debug route `POST /internal/debug/fail` calls the same method.

*Verified by:* §3.5 and §7.11 list the Nack tests.

### 3.1 Inputs

| Name        | Type       | Meaning                                                                                                       |
|-------------|------------|---------------------------------------------------------------------------------------------------------------|
| `workerID`  | `string`   | Same as Ack §2.1.                                                                                             |
| `jobID`     | `string`   | Same as Ack §2.1.                                                                                             |
| `error`     | `JobError` | Structured error metadata. `class` and `message` are required. `stackTrace` is optional (empty string OK). `occurredAt` is optional; the repository fills `time.Now()` when zero. |
| `permanent` | `bool`     | Default `false`. When `true`, Nack dead-letters immediately regardless of attempt budget (§7). Sourced from `handler.Error.Permanent`. |

### 3.2 Preconditions

Identical to Ack §2.2. Same sentinel errors.

### 3.3 Locking discipline

Identical to Ack §2.3.

### 3.4 Effects

In one transaction:

1. The active attempt row (same lookup as Ack §2.4 step 1) is closed:
   - `outcome = 'failed'`
   - `ended_at = now()`
   - `error_class = error.Class`
   - `error_message = error.Message`

2. The `jobs` row is updated based on the **terminality decision**
   (`terminal  ⟺  attempt >= max_attempts  OR  permanent = true`; see §7):

   - If `permanent = true` — the handler declared the failure permanent.
     Dead-letter immediately, **regardless of remaining attempt budget**,
     with the handler's own `JobError` (not a synthetic class):
       - `status = 'dead_lettered'`
       - `dead_lettered_at = now()`
       - `error = <handler error marshalled to JSONB>`
       - `current_worker_id = NULL`
       - `lease_expires_at = NULL`
       - `next_retry_at` stays NULL (never set on this path)

   - Else if `jobs.attempt >= jobs.max_attempts` — the job has now exhausted
     its attempt budget and is dead-lettered:
       - `status = 'dead_lettered'`
       - `dead_lettered_at = now()`
       - `error = <error marshalled to JSONB>`
       - `current_worker_id = NULL`
       - `lease_expires_at = NULL`

   - Otherwise — the job is retryable. Nack additionally computes the
     wall-clock time at which the next attempt should be permitted
     (see §3.5 for the full rule) and stores it on the row, all in the
     same `UPDATE`:
       - `status = 'failed'`
       - `error = <error marshalled to JSONB>`
       - `current_worker_id = NULL`
       - `lease_expires_at = NULL`
       - `next_retry_at = <computed per §3.5.1, jittered per §3.5.2>`

The `attempt` counter is **not** modified on Nack. It was already incremented
by Dequeue at claim time; that increment is the canonical record of "this
attempt was attempted."

### 3.5 Retry scheduling

A Nacked job that has not exhausted its attempt budget enters the
**retry pipeline**. The pipeline has two phases, owned by two different
components:

1. **Decide** — Nack itself, in the same transaction that records the
   failure, computes the wall-clock time at which the next attempt
   should be permitted and stores it on the job row as `next_retry_at`.
   This produces a **concrete, deterministic** queue state — the moment
   Nack commits, the future of this job is fully specified.

2. **Promote** — the retry scheduler, running as a goroutine elsewhere
   in the `apps/api` process, periodically scans for failed rows whose
   `next_retry_at` has elapsed and transitions them `failed → queued`
   in a single atomic `UPDATE`. This is the moment the job becomes
   visible to dequeue again.

This split is load-bearing:

- The retry decision is taken once, by the only code that has the full
  failure context (handler, error class, attempt count, backoff config).
  It is **not** recomputed.
- The scheduler is stateless. Its job is "rows due for promotion →
  `queued`." A scheduler crash delays promotion; it does not lose,
  duplicate, or alter retry decisions.
- A reader (operator UI, debug session, replay tool) inspecting
  `(status, next_retry_at)` always sees the same future timeline,
  regardless of when the scheduler last ticked.

The same rule that justifies the split is the rule that breaks if either
side drifts: any code that *recomputes* a retry time after Nack — for
example, "re-jitter on scheduler restart" — invalidates queue
determinism. Don't.

#### 3.5.1 Nack-side computation

When §3.4's terminality check selects the retryable branch
(`attempt < max_attempts`), Nack additionally:

1. Reads `jobs.backoff` (already in scope on the locked row).
2. Computes a base delay from the backoff strategy:
   - `exponential`: `min(baseSeconds * 2^(attempt - 1), capSeconds)`.
     `attempt` here is the post-Dequeue increment value (i.e. the
     attempt that just failed). The first failed attempt yields
     `baseSeconds`; the second yields `2 × baseSeconds`; and so on,
     clipped at `capSeconds`.
   - `fixed`: `seconds`.
3. Applies **full jitter** (§3.5.2) to the base delay, producing a
   single concrete delay value.
4. Stores `next_retry_at = now() + jittered_delay` in the same
   `UPDATE jobs SET ...` statement that writes the retryable status
   transition (§3.4).

The compute-and-store is **atomic with the failure**. There is no state
in which `(status='failed', next_retry_at IS NULL)` is durable; that
combination violates invariant §3.5.4(1).

#### 3.5.2 Jitter

The base delay computed in §3.5.1 is multiplied by a uniformly random
factor drawn from `[0.5, 1.5]`:

```
jittered_delay = base_delay * (0.5 + uniform_random(0, 1))
```

This is a variant of the AWS "full jitter" pattern, with the lower
bound at 50% rather than 0% to preserve a meaningful minimum backoff.
The motivation is herd resilience: without jitter, a downstream outage
that causes 1000 jobs to fail at the same instant schedules 1000
retries at the same instant, re-collapsing the downstream the moment
it recovers.

**The randomness is sampled exactly once, by the Nack path, before the
`UPDATE` commits.** After commit, `next_retry_at` is a concrete
timestamp and is not recomputed under any circumstance — not by the
scheduler, not by replay, not by debug tools, not by tests. This is
the **deterministic-after-commit** invariant. Violating it puts the
queue in a state where two readers disagree about a job's future.

Implementations may use any uniform PRNG; the spec does not pin a
distribution other than the range. A test that needs reproducibility
should seed the PRNG via the implementation's test surface, not by
mutating `next_retry_at` after the fact.

#### 3.5.3 Scheduler-side promotion

Implementation: `apps/api/internal/retries/scheduler.go`.

The retry scheduler runs as a background goroutine in the `apps/api`
process. Its sole job is to flip retry-due rows from `failed` to
`queued`. The full operation is one SQL statement:

```sql
UPDATE jobs
SET    status        = 'queued',
       next_retry_at = NULL
WHERE  id IN (
    SELECT id FROM jobs
    WHERE  status        = 'failed'
      AND  next_retry_at IS NOT NULL
      AND  next_retry_at <= now()
    ORDER BY next_retry_at ASC
    LIMIT  $1
    FOR UPDATE SKIP LOCKED
)
RETURNING id, queue, handler, attempt, next_retry_at;
```

Notes:

- **`SKIP LOCKED`** mirrors dequeue (§1.4) and makes the predicate safe
  to run concurrently from multiple api replicas in the future. Each
  tick is independent of other ticks.
- The `LIMIT` caps the batch size per tick so a single tick can't
  starve other DB traffic. A reasonable default is 256; the parameter
  is part of the scheduler's config and lives outside the spec.
- `next_retry_at` is cleared to `NULL` on promotion to satisfy
  invariant §3.5.4(1).
- **Nothing else is touched.** `attempt` does **not** increment here —
  it bumps at the next claim (§1.6). `priority`, `payload`,
  `max_attempts`, `backoff`, `idempotency_key`, `queue`, `handler`,
  `enqueued_at` are all immutable across the retry: the row's identity
  is preserved.
- The statement is implicitly transactional, atomic, and crash-safe. A
  scheduler that dies mid-promotion rolls back; the next tick
  reproduces the same predicate and the same result set.

The predicate is served by `idx_jobs_retry_pending` from migration
`000001_create_jobs_table.up.sql`:

```sql
CREATE INDEX idx_jobs_retry_pending
    ON jobs (queue, handler, priority DESC, next_retry_at ASC)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;
```

The partial WHERE matches the scheduler's filter exactly, so only
retry-pending rows are visited. The composite ordering serves both the
scheduler (which sorts by `next_retry_at` over a small set, cheaply) and
the future per-queue dispatch view. No additional index is needed for
the scheduler at this scale. Revisit if soak shows the sort becoming
hot — at which point an additional `(next_retry_at)`-only partial index
is a one-migration follow-up.

#### 3.5.4 Invariants

The following must hold at every transaction boundary:

1. **`next_retry_at` exists iff `status = 'failed'`.**
   - `status='failed'  AND next_retry_at IS NOT NULL` — retry pending.
   - `status!='failed' AND next_retry_at IS NULL`     — all other states.
   - The combinations `(status='failed', next_retry_at IS NULL)` and
     `(status!='failed', next_retry_at IS NOT NULL)` are forbidden.
   - This must eventually be enforced by a `CHECK` constraint at the
     schema level; until then, the invariant is upheld by code review
     of every site that writes `status`.

2. **`next_retry_at` is set exactly once per attempt.** Nack writes
   it; promotion clears it. No path "re-jitters" or "re-schedules"
   a retry in place. To change the retry time, cancel and re-enqueue.

3. **Promotion preserves the row's identity.** A retry is the SAME
   job, on the SAME queue, with the SAME handler, payload, priority,
   idempotency key, and backoff. Only `(status, next_retry_at)` move.

4. **Promotion does not change `attempt`.** `jobs.attempt` is the
   execution counter. It bumps at claim (§1.6); it does not bump at
   retry promotion.

#### 3.5.5 Cadence and lag

The scheduler runs at a fixed interval (default 5 seconds, env-
configurable). Promotion happens at the next tick at or after
`next_retry_at`, so the worst-case lag between "retry due" and "row
visible to dequeue" is one tick interval. This is the **scheduler
lag** and is observable per row as `now() - next_retry_at` at
promotion time.

A growing lag is the canonical signal that the scheduler is starved
(too many failed jobs per tick exceeding the batch limit, DB latency,
or scheduler down). The `queue.retry.promoted` event carries `lagMs`
for exactly this purpose; operator dashboards should chart it.

A scheduler outage simply defers promotion; the retry decision (set
in Nack) is durable in the row. There is no recovery action required
when the scheduler comes back — the next tick scans the backlog and
promotes everything due.

#### 3.5.6 Cancellation interaction

Normative Cancel semantics live in [§6 Cancel](#6-cancel). From the
retry-pending state `(status='failed', next_retry_at IS NOT NULL)`,
Cancel MUST clear `next_retry_at` when flipping to `cancelled`
(invariant §3.5.4(1)). The scheduler skips `cancelled` rows by
predicate (`status='failed'` filter). Cancel and promote both take a
row-level lock; whichever commits first wins and the loser's
predicate no longer matches.

#### 3.5.7 Queue pause interaction

(Forward reference — queue pause is not yet implemented.)

When queue pause exists, retry promotion **respects pause**. A
retry-due job in a paused queue must not become visible to dequeue.
Two implementation options are equivalent for spec purposes; pick at
implementation time:

- **Promote-but-hide**: scheduler promotes `failed → queued` freely;
  dequeue's predicate adds a pause filter.
- **Defer-promote**: scheduler's predicate adds a pause filter,
  leaving retry-due rows in `failed` until the queue resumes.

The spec mandates the *behavior*: retries do not bypass pause. The
implementation detail will be pinned in the pause spec.

#### 3.5.8 Reclaim interaction

The reclaim primitive (§5) and the retry scheduler are **orthogonal**:
reclaim acts on rows in `status='running'`; the scheduler acts on rows
in `status='failed'`. They never touch the same row.

This holds across both reclaim invocation sites:

- **§5.5.1** (`InlineClaim`, dequeue path): the new worker takes the
  row directly to `running` again under a fresh lease. Never touches
  `next_retry_at`.
- **§5.5.2** (`TickRequeue`, api-side periodic): the tick takes the
  row from `running` to `queued` (NOT `failed`). Never touches
  `next_retry_at`, which remains `NULL` (the row was never `failed`).
- **§5.6** (budget-exhausted, either site): the row goes to
  `dead_lettered` directly, bypassing the retry pipeline.

Equivalently: the retry pipeline is entered only by Nack with budget
remaining. Reclaim is a separate recovery path with its own
terminality decisions, and lease expiration is treated as **ownership
loss, not handler failure** — charging it to the attempt budget (by
incrementing `attempt` or routing through `failed`) would conflate
two different semantic concepts and pollute the retry pipeline. See
[§5.8](#58-ordering-vs-retry-scheduler) for the design rationale.

#### 3.5.9 Errors

The Nack-side computation cannot fail in a meaningful way: backoff is
a typed value on the row, jitter is local randomness, and the
`UPDATE` is the same SQL that Nack already runs. Any failure here is
already covered by Nack's existing error envelope (§3.7).

The scheduler-side promotion can fail in three ways:

- **DB query error**: log `queue.retry.scheduler.tick_failed` with the
  wrapped pgx error. The next tick retries; partial progress is
  preserved by `SKIP LOCKED`.
- **Context cancellation (graceful shutdown)**: not an error. Emit
  `queue.retry.scheduler.stopped` and return.
- **Scheduler not running**: no event is emitted (the symptom is
  silence). Operator-facing detection lives in the lag canary (§3.5.5):
  a growing `oldest_failed_due_lag` metric is the health signal.

#### 3.5.10 Observability contract

| Event                                | Level | Required fields                                                                                                |
|--------------------------------------|-------|----------------------------------------------------------------------------------------------------------------|
| `queue.retry.scheduled`              | info  | `jobId`, `queue`, `handler`, `attempt`, `maxAttempts`, `nextRetryAt` (RFC3339), `delaySeconds`, `errorClass`   |
| `queue.retry.scheduler.started`      | info  | `intervalSeconds`, `batchLimit`                                                                                |
| `queue.retry.scheduler.stopped`      | info  | `reason` (`canceled` / `deadline_exceeded` / other)                                                            |
| `queue.retry.scheduler.tick_failed`  | error | `err`                                                                                                          |
| `queue.retry.promoted`               | info  | `jobId`, `queue`, `handler`, `attempt`, `scheduledForRetryAt`, `lagMs`                                         |

`queue.retry.scheduled` is emitted by **Nack** (one per retryable
failure). `queue.retry.promoted` is emitted by **the scheduler** (one
per row promoted). The two are correlated by `jobId`, so the operator
timeline can be reconstructed as:

```
schedule(t0) → promote(t1) → claim(t2) → ack/nack(t3)
```

Names are camelCase. Implementation uses `log/slog`. Extra fields are
permitted but the listed ones are required for the operator dashboard
to function.

#### 3.5.11 Verified by

| Spec clause | Coverage |
|-------------|----------|
| §3.5.1 (exponential and fixed base delay) | `TestBaseBackoffSeconds_Exponential`, `TestBaseBackoffSeconds_Fixed`, `TestBaseBackoffSeconds_Defensive` (`packages/queue-core/backoff_test.go`) |
| §3.5.2 (jitter range) | `TestComputeRetryDelaySeconds_JitterInRange` (`packages/queue-core/backoff_test.go`) |
| §3.5.1 (`next_retry_at` written atomically with failure) | `TestNack_Retry_DefaultUnchanged` (`packages/queue-core/repository_complete_test.go`) |
| §3.5.3 (scheduler promotion, batch limit, `attempt` untouched) | **gap**: no test yet |
| §3.5.4 (invariants across statuses) | **gap**: no test yet |
| §3.5.5 (promotion lag event) | **gap**: no test yet |
| §3.5.8 (reclaim leaves `next_retry_at` NULL) | **gap**: no test yet |

### 3.6 Idempotency

Nack is **not** idempotent. Same reasoning as Ack §2.5.

### 3.7 Errors

Same sentinels as Ack §2.6.

### 3.8 Observability contract

| Event                       | Level | Required fields                                                                                                 |
|-----------------------------|-------|-----------------------------------------------------------------------------------------------------------------|
| `queue.nack.guard_failed`   | warn  | `workerId`, `jobId`, `reason` (`not_found` / `lease_lost` / `lease_expired`)                                    |
| `queue.nack.recorded`       | info  | `workerId`, `jobId`, `attempt`, `maxAttempts`, `terminal` (bool), `errorClass`, `disposition` ∈ {`retry`, `permanent`, `budget_exhausted`} |
| `queue.dlq.permanent`       | warn  | `workerId`, `jobId`, `handler`, `attempt`, `maxAttempts`, `errorClass` — emitted when Nack dead-letters via the permanent branch (§7) |
| `queue.retry.scheduled`     | info  | `jobId`, `queue`, `handler`, `attempt`, `maxAttempts`, `nextRetryAt`, `delaySeconds`, `errorClass`              |

`queue.retry.scheduled` is emitted on the retryable branch of §3.4 (i.e.
when the job is NOT dead-lettered). It complements `queue.nack.recorded`
with the retry-pipeline-specific fields. The full retry observability
surface (including the scheduler's events) is documented in §3.5.10.
`queue.dlq.permanent` never fires for budget-exhausted or reclaim DLQs.

Names are camelCase. Implementation uses `log/slog`. Extra fields are permitted.

---

## 4. Lease Renewal

Lease renewal (a.k.a. ExtendLease) is how a worker proves that **one specific
job execution** is still healthy and pushes its `lease_expires_at` deadline
forward. It is per-job, not per-worker.

It is **not** the worker heartbeat. The worker heartbeat
(`UPDATE workers SET last_heartbeat_at = now() WHERE id = $me`) proves the
*runtime process* is alive. The two operations have different cadence,
different storage, and different failure semantics:

| Aspect              | Worker heartbeat                       | Lease renewal                          |
|---------------------|----------------------------------------|----------------------------------------|
| What it asserts     | "this runtime process is alive"        | "this attempt of this job is healthy"  |
| Storage             | `workers.last_heartbeat_at`            | `jobs.lease_expires_at`                |
| Scope               | one row per worker process             | one row per in-flight job              |
| If it fails         | runtime is evicted, process exits      | this job's execution aborts; lease is left to expire so reclaim can pick it up |
| Spec section        | out of scope (operator-table concern)  | this section                           |

A worker can be heartbeating fine while a specific job execution has hung,
deadlocked, or already completed. Conflating them defeats the reclaim path.

The implementation is `Repository.RenewLease(ctx, RenewParams)` in
`packages/queue-core/repository.go`. The worker runtime calls it every 10 seconds
per in-flight job (`apps/worker/internal/runtime/worker.go`). The debug route
`POST /internal/debug/renew` calls the same method.

*Verified by:* no automated test yet (gap).

### 4.1 Inputs

| Name      | Type     | Meaning                                                                              |
|-----------|----------|--------------------------------------------------------------------------------------|
| `workerID`| `string` | The runtime id of the caller — must equal `jobs.current_worker_id` for the call to succeed. |
| `jobID`   | `string` | The job whose lease is being extended.                                               |

### 4.2 Preconditions

Identical to Ack §2.2 — renewal shares the same lease guard:

1. A row exists in `jobs` with `id = $jobID`. Otherwise → `ErrJobNotFound`.
2. That row's `status = 'running'` **and** `current_worker_id = $workerID`.
   Otherwise → `ErrLeaseLost`.
3. `lease_expires_at > now()`. Otherwise → `ErrLeaseExpired`. A worker whose
   lease has already lapsed has forfeited the authority to extend it;
   reclaim is no longer racing — it has already won.

The comparison in (3) uses the database clock (`now()` in SQL), **never** the
worker's application clock. This is the central correctness property of this
operation: lease authority is decided exclusively by Postgres so that clock
skew between worker and DB cannot let an already-expired lease silently
extend itself. Workers do not pass timestamps in; the DB writes them.

### 4.3 Locking discipline

Identical to Ack §2.3. The call opens a transaction and takes
`SELECT ... FOR UPDATE` on the `jobs(id)` row — **no** `SKIP LOCKED`. Two
concurrent renewals for the same job (a worker bug — a worker should spawn
one renewer per in-flight job) must serialize, not skip.

The lock is held across the guard check and the single-column UPDATE; both
commit atomically.

### 4.4 Effects

In one transaction:

1. The `jobs` row is updated:
   - `lease_expires_at = now() + INTERVAL '30 seconds'` (fixed lease duration; see §1.8 — promoting this to per-job or worker-proposed lives in a later spec revision)

No other column is touched. `status` stays `'running'`. `current_worker_id`
stays equal to `$workerID`. `attempt`, `started_at`, the in-flight
`job_attempts` row, and every other field are untouched: **renewal is not the
start of a new attempt**, it is a deadline push on the existing one.

The `jobs_lease_consistency` CHECK constraint is satisfied because the
`(status, current_worker_id, lease_expires_at)` triple stays internally
consistent: still `running`, still non-NULL, still non-NULL.

### 4.5 Worker contract on failure — abort immediately

When `RenewLease` returns `ErrLeaseLost`, `ErrLeaseExpired`, or
`ErrJobNotFound`, the calling worker **MUST** abort execution of this job
immediately. It MUST NOT subsequently call `MarkJobSucceeded` or
`MarkJobFailed` for the same `jobID` — the row's outcome belongs to whoever
reclaims it.

(The completion calls would themselves fail the same guard, so a wayward
worker cannot corrupt state. But "abort first, do not even try" is the rule:
it keeps logs and metrics honest about which worker owned the outcome.)

The displaced worker leaves the lease coordinates as they are — either the
lease has already expired, or it will shortly. The reclaim path (§1.5) picks
the job up on the next Dequeue that matches the predicate.

### 4.6 Cadence — worker responsibility

Renewal is **pulled** by the worker, not pushed by the queue. The queue does
not schedule renewals; it accepts whatever cadence the worker chooses, so
long as a successful renewal arrives before `lease_expires_at`.

The current contract is:

- Lease duration: 30 seconds (the §1.8 constant).
- Renewer interval: 10 seconds (3 attempts per lease window, giving 20s+ of
  margin for transient DB latency).

The renewer is per-job, not per-worker. A worker executing N jobs in parallel
runs N independent renewer loops. (Today `max_concurrency = 1`, so N = 1, but
the design must work when that lifts.)

There is no "max renewals" cap. A correctly-behaving worker may renew
indefinitely; runaway runtimes are caught by the worker-heartbeat sweeper
(out of scope here), which marks dead `workers` rows `disconnected`. That
mechanism is orthogonal — it does not touch leases — but it ensures the
operator UI flags the runtime even while its jobs are still renewing.

### 4.7 Idempotency

Renewal is effectively idempotent on the single column it writes.
`lease_expires_at` is unconditionally overwritten with `now() + 30s` on every
call; two renewals at essentially the same instant produce nearly-identical
deadlines, and nothing observable changes.

This is unlike Ack/Nack, which have terminal side effects (closing the
attempt row, transitioning status) and therefore fail the guard on a second
call. Renewal has neither.

### 4.8 Errors

| Sentinel             | Meaning                                                                                  |
|----------------------|------------------------------------------------------------------------------------------|
| `ErrJobNotFound`     | No `jobs` row with the given id (the row was deleted out from under us).                 |
| `ErrLeaseLost`       | Status is not `running`, or `current_worker_id` does not match `$workerID`.              |
| `ErrLeaseExpired`    | The caller still owns the row, but `lease_expires_at <= now()` per the DB clock.         |

Callers branch with `errors.Is`. Any other error is wrapped with the function
name and returned. **All three sentinels trigger the §4.5 abort contract.**

### 4.9 Observability contract

| Event                | Level | Required fields                                                                                                |
|----------------------|-------|----------------------------------------------------------------------------------------------------------------|
| renew succeeded      | debug | `workerId`, `jobId`, `attempt`, `newLeaseExpiresAt`, `leaseDurationSeconds`                                    |
| guard failed         | warn  | `workerId`, `jobId`, `reason` (`not_found` / `lease_lost` / `lease_expired`)                                   |

Success is **debug**, not info: renewal is a high-cadence operation (every
10s per in-flight job) and emitting info per call would drown operator logs.
Guard failures stay at **warn** — they represent a worker being displaced,
which the operator wants to see.

Names are camelCase to match the frontend contract. The implementation uses
`log/slog`. Extra fields are permitted.

---

## 5. Reclaim

Reclaim is the primitive that transitions a job whose lease has expired
out of `running` state. It is the system's only mechanism for recovering
ownership when a worker stops heartbeating — for any reason: crash,
kernel kill, network partition, host pause, container restart, OOM.

There is exactly **ONE** implementation of reclaim in the codebase,
living in `packages/queue-core/`. Multiple call sites invoke it. Two
parallel implementations of reclaim would silently miscount attempts,
mis-trigger DLQ, and let lease ownership end up in inconsistent states.
This rule is non-negotiable; see `feedback-shared-semantics-shared-primitive`
and the 2026-05-26 SOAK_REPORT for the motivating evidence.

### 5.1 Invocation sites

Two sites, both invoking the SAME primitive with the SAME locking,
transaction shape, attempt-row accounting, constraint guarantees, and
observability contract. They differ ONLY in (a) how rows are selected
and locked before invocation, and (b) what continuation runs after a
successful reclaim with budget remaining ([§5.5](#55-effects--budget-remaining-branch-attempt--max_attempts)).

| Site | Trigger | Candidate selection | Post-reclaim continuation (budget remaining) |
|------|---------|---------------------|---------------------------------------------|
| **Inline (dequeue)** | a worker calls Dequeue and §1.5 routes a `running` candidate here | one row, already FOR-UPDATE'd by [§1.4 Locking discipline](#14-locking-discipline); the candidate has `status='running' AND lease_expires_at + reclaim_grace <= now()` (§1.2) | claim the row under the new worker; return `*Job` (§5.5.1) |
| **Tick (api-side periodic)** | an api-process timer fires at the configured interval | batch `SELECT … FOR UPDATE SKIP LOCKED` of rows where `status='running' AND lease_expires_at + reclaim_grace <= now()`, bounded by per-tick `LIMIT` | requeue to `status='queued'`; do NOT claim (§5.5.2) |

The two sites are orthogonal: `FOR UPDATE SKIP LOCKED` on both means a
row a dequeue is currently mutating is invisible to the tick scan, and
vice versa. Concurrent invocations cannot reclaim the same row twice
(see [§5.7](#57-concurrency-and-idempotency)).

### 5.2 Inputs

The reclaim primitive is parameterized by:

| Input | Type | Meaning |
|-------|------|---------|
| `tx` | pgx transaction handle | The row(s) being reclaimed MUST already be locked within this tx by the caller. The primitive does not issue the SELECT. |
| `mode` | `ReclaimMode` enum | One of `InlineClaim` (§5.5.1 continuation) or `TickRequeue` (§5.5.2 continuation). |
| `job` | `*Job` | The row being reclaimed; the caller has already SELECTed and locked it. |
| `claimingWorkerID` | `string` (ULID) | Required when `mode == InlineClaim`; the runtime id of the worker taking over. Unused for `TickRequeue`. |

Reclaim deliberately does NOT issue the SELECT. The selection predicate
differs per site (single-row by id vs batched by predicate), as does
the ordering. Reclaim owns only the state transitions, not row
discovery. This separation is what lets ONE primitive serve TWO callers
without conditionals on call-site identity inside the primitive itself.

### 5.3 Preconditions

The caller MUST ensure all of the following before invoking the
primitive. Violations of the structural items (locked row, valid
params) are caller bugs and surface as wrapped errors without
sentinel types. Violations of the state items (status, attempt,
lease expiry) are NOT caller bugs — they reflect concurrent activity
that may have raced between the caller's SELECT and the primitive's
UPDATE — and are handled by [§5.4 post-lock revalidation](#54-effects--post-lock-revalidation--close-prior-attempt-always-both-modes-both-branches).

Structural (caller-only):

- The row is locked `FOR UPDATE` within `tx`.
- A `job_attempts` row matching `(job_id, attempt_number = caller-passed attempt)` exists (it MAY have `ended_at IS NOT NULL` — see §5.4 for handling).
- When `mode == InlineClaim`: `claimingWorkerID` is a non-empty ULID different from `job.current_worker_id`.

State (caller-asserted, primitive-re-verified):

- `job.status == 'running'` AT THE TIME OF CALLER'S SELECT.
- `job.lease_expires_at + reclaim_grace <= now()` AT THE TIME OF CALLER'S SELECT.
- `job.attempt == caller-passed attempt`.

The state items are advisory. The primitive re-verifies them
authoritatively under the held lock as part of §5.4. If the row has
changed state between SELECT and the primitive's UPDATE — the lease
was renewed, the prior attempt completed and a new one started, the
job was cancelled or dead-lettered by another path — the primitive
returns `ReclaimOutcomeStale` and performs no mutation.

The `reclaim_grace` window is also re-verified by the primitive
(against the DB's `now()`), not just by the caller's selection. The
caller's SELECT establishes candidacy; the primitive's recheck
establishes authority. This is the "**selection is advisory,
post-lock is authoritative**" invariant. Future call sites are free
to use any selection strategy — including no predicate at all (e.g.
a row-by-id reclaim invoked from an admin tool) — and the primitive
will still refuse to mutate a row that doesn't satisfy the state
predicates under the lock.

### 5.4 Effects — post-lock revalidation + close prior attempt (always; both modes, both branches)

The first step the primitive runs, before branching on budget, is a
**single conditional UPDATE** that (a) re-verifies the row is still
in the reclaimable state under the held lock and (b) closes the prior
attempt. Combining the two into one statement keeps the primitive at
one round-trip per row and makes the recheck atomic with the
mutation: a row whose state changes between recheck and write cannot
exist.

The SQL takes the shape:

```sql
UPDATE job_attempts ja
SET outcome  = 'lease_lost',
    ended_at = now()
FROM jobs j
WHERE ja.job_id         = $1                                    -- caller's JobID
  AND ja.attempt_number = $2                                    -- caller's Attempt
  AND ja.ended_at IS NULL                                       -- attempt still in-flight
  AND j.id              = $1
  AND j.status          = 'running'                             -- row still running
  AND j.attempt         = $2                                    -- attempt counter unchanged
  AND j.lease_expires_at + make_interval(secs => $3) <= now()   -- lease still expired beyond grace
```

`RowsAffected` is the post-lock truth:

- **`RowsAffected == 1`**: the row passed all state checks under the
  lock. The attempt is now closed with `outcome='lease_lost'`. The
  primitive proceeds to §5.5 or §5.6 depending on attempt budget.
- **`RowsAffected == 0`**: one or more of the state predicates failed
  under the lock — the row changed between the caller's SELECT and
  this UPDATE. Possible causes: the prior worker renewed its lease
  (caught by `j.lease_expires_at + grace <= now()`), the row was
  already reclaimed by another caller (caught by `j.status =
  'running'` or `j.attempt = $2`), the attempt was closed by a Nack
  / Cancel path (caught by `ja.ended_at IS NULL`), or the job was
  cancelled / dead-lettered. The primitive emits
  `queue.reclaim.row.stale` (§5.12), returns
  `ReclaimOutcomeStale`, and performs **no further mutation**. The
  caller's continuation MUST treat Stale as "this row is no longer
  ours to touch" — Dequeue returns `(nil, nil)` (poll again); the
  tick driver counts the row as stale and continues the batch.

The choice of `now()` for `ended_at` (rather than the prior
`lease_expires_at`) is deliberate: we record when the system
*noticed* the loss, not when the lease technically expired. A future
revision may switch this to `lease_expires_at` if operator dashboards
need attempt-duration accuracy; if so, change here, not at the call
sites.

`ReclaimOutcomeStale` is a normal outcome, not an error. Stale rates
are an operator-facing signal that grace tuning or lease duration may
be too aggressive; the tick driver surfaces them in
`queue.reclaim.tick`'s `stale` field (§5.12).

### 5.5 Effects — budget-remaining branch (`attempt < max_attempts`)

The prior attempt is closed (§5.4). The continuation branches on `mode`:

#### 5.5.1 mode = InlineClaim (dequeue)

The new caller takes over. Inside the same transaction, after §5.4:

1. UPDATE `jobs` per [§1.6 Claim update](#16-claim-update):
   `status='running'`, new `current_worker_id`, fresh `lease_expires_at`,
   `attempt += 1`, `started_at = COALESCE(started_at, now())`.
2. INSERT a new `job_attempts` row per [§1.7 Attempt history](#17-attempt-history)
   with `attempt_number = jobs.attempt` (post-increment).

The primitive returns the claimed `*Job` to the caller (Dequeue).
Dequeue returns it to its caller.

#### 5.5.2 mode = TickRequeue (api-side periodic)

There is no new owner. After §5.4:

1. UPDATE `jobs`:
   - `status = 'queued'`
   - `current_worker_id = NULL`
   - `lease_expires_at = NULL`
   - `attempt` is **NOT** incremented.
   - `next_retry_at` remains `NULL` (it was `NULL` throughout because
     the row was never in `'failed'`).

   The row is now indistinguishable from a fresh queued candidate to
   the next Dequeue: the next dequeue that picks it up goes through
   the standard "fresh queued candidate" path, increments `attempt`,
   and inserts a new `job_attempts` row per §1.6 + §1.7.

2. Do NOT INSERT a new `job_attempts` row. No handler attempt is
   starting here — the row is going back into the runnable pool.

**Invariant — scheduling intent is preserved.** TickRequeue MUST NOT
rewrite `scheduled_for`, `priority`, or any other column influencing
ordering. The row reappears in the runnable set with its **original
scheduling coordinates**. Setting `scheduled_for = now()` would
silently change queue fairness: a row scheduled for a specific future
time would jump ahead of other rows that have been waiting longer; a
priority-deprioritized row would be re-treated as a fresh enqueue
relative to its peers. Reclaim is a recovery path, NOT a
re-enqueue. Implementations and reviewers MUST reject any change
that rewrites scheduling fields as part of reclaim.

**Rationale (load-bearing — do not change without ADR).** Lease
expiration is **ownership loss**, not a handler failure. Charging it
to the attempt budget (by incrementing `attempt`, or by routing
through `status='failed'` so the retry pipeline picks it up) would
conflate two semantic concepts: the worker process died, but the
handler's correctness/runnability did not. A row whose attempt budget
gets consumed only when a handler actually runs preserves the
invariant that `jobs.attempt` counts handler invocations.

The alternative design — tick reclaim transitions to `'failed'` so the
retry scheduler promotes it back to `'queued'` — was rejected for the
same reason, plus it would create a shared mutation surface between
reclaim and the retry scheduler. See [§5.8](#58-ordering-vs-retry-scheduler).

The `jobs_lease_consistency` CHECK constraint is satisfied by the
simultaneous write of `status='queued'`, `current_worker_id=NULL`, and
`lease_expires_at=NULL`. The `jobs_retry_consistency` constraint is
satisfied because `next_retry_at` is `NULL` throughout this branch
(non-`failed` rows require `next_retry_at IS NULL`).

### 5.6 Effects — budget-exhausted branch (`attempt >= max_attempts`)

The job has burned its full retry budget on the very attempt whose
lease just expired. There is no attempt left to give. **Same for BOTH
modes**: dead-letter in place. After §5.4:

1. UPDATE `jobs`:
   - `status = 'dead_lettered'`
   - `dead_lettered_at = now()`
   - `error` is the JSONB encoding of a `JobError` Go value — class
     `AttemptBudgetExhausted` (verbatim — used by operator filters),
     message naming the attempt number and budget, `occurredAt` set
     at construction. JSON shape is exactly `JobError`: fields `class`,
     `message`, `stackTrace`, `occurredAt`. No other writer may emit a
     different shape into this column.
   - `current_worker_id = NULL`
   - `lease_expires_at = NULL`
   - `attempt` is **NOT** incremented (no new attempt was started).

2. Do NOT INSERT a new `job_attempts` row (same reason).

Per-mode continuation after the UPDATE returns:

- **InlineClaim**: the primitive returns `(nil, nil)` to Dequeue.
  Dequeue returns `(nil, nil)` to its caller; the caller polls again.
  The DLQ side-effect is bonus work Dequeue performs to keep the
  queue from accumulating doomed-but-runnable rows; it is not a
  failure case for the caller.
- **TickRequeue**: the primitive records the per-row DLQ event in
  the tick's summary. The tick continues the batch — one DLQ does
  not abort processing of the rest.

The constraint reasoning carries over verbatim from prior §1.5.2:
`jobs_attempt_bounds` (`attempt <= max_attempts`) is satisfied because
we leave `attempt` unchanged. `jobs_terminal_exclusivity` is satisfied
because we set `dead_lettered_at` simultaneously with
`status='dead_lettered'`. `jobs_lease_consistency` is satisfied because
we clear `current_worker_id` and `lease_expires_at` simultaneously with
the move out of `running`.

The `now()` written to `dead_lettered_at` and the `now()` written to
the prior attempt's `ended_at` in §5.4 are two independent clock reads
from Postgres in the same transaction. They will be very close but are
not guaranteed equal; do not assert equality between them.

This branch exists for a real edge case: a worker that crashes during
its final allowed attempt. Without it, the row sits as a perpetually-
runnable reclaim candidate that every claim attempt fails to update
(constraint violation), and the queue effectively wedges on this
single row. See the 2026-05 incident log for the reproduction.

### 5.7 Concurrency and idempotency

Reclaim MUST be safe to invoke redundantly. The lock discipline plus
the precondition checks (§5.3) plus the `ended_at IS NULL` guard in
§5.4 jointly guarantee three properties:

1. **Two concurrent callers cannot both reclaim the same row.** Both
   sites use `FOR UPDATE [SKIP LOCKED]`. One caller gets the row; the
   other either skips it (SKIP LOCKED) or, if it had a stale SELECT,
   re-reads under the lock and discovers `status != 'running'` (because
   the first caller already moved it), failing §5.3 — the second
   caller's invocation no-ops.

2. **A single caller invoking reclaim twice in two distinct
   transactions on the same row is safe.** The first invocation
   transitions the row out of `running`. The second invocation's
   precondition check (§5.3) fails — `job.status != 'running'` or
   `job.lease_expires_at >= now()` (in the requeue branch, the new
   `running` row has a fresh, future-dated lease). The primitive
   returns without writing.

3. **A tick that crashes mid-batch is safe.** The transaction rolls
   back. The next tick scan finds the same rows (still satisfying
   `status='running' AND lease_expires_at < now()`) and reclaims them
   cleanly. No half-closed prior attempts, no half-updated `jobs`
   rows, no orphaned `job_attempts` rows.

**Semantic guarantee (preserved across both branches and both modes).**
The previous owner can never silently complete a reclaimed job. The
lease guard on Heartbeat, Ack, and Nack
(`WHERE current_worker_id = $me AND status = 'running'`) updates zero
rows once `current_worker_id` has been reassigned or cleared. The
displaced owner discovers the loss only when it next touches the row.

This guarantee depends on worker IDs being ephemeral per process boot.
A crashed runtime's id never returns; the new boot inserts a fresh row.
If two runtimes coincidentally shared an id, Heartbeat from the new
runtime would silently extend the dead runtime's lease and reclaim
would never fire. See `project_ephemeral_worker_runtimes`.

### 5.8 Ordering vs retry scheduler

Reclaim acts on rows in `status='running'`. The retry scheduler (§3.5)
acts on rows in `status='failed'`. The two never touch the same row.

This orthogonality is **load-bearing** and was chosen deliberately. An
alternative design where `TickRequeue` transitioned rows to `failed`
(so the retry scheduler would promote them back to `queued`) was
rejected because:

- It would create a shared mutation surface between two subsystems
  that are currently independent. Every interaction (concurrent
  promotion + concurrent reclaim of the same row, ordering of writes
  to `next_retry_at`, ordering of attempt counter increments) would
  need to be specified between subsystems.
- It would semantically conflate lease expiration with handler
  failure — see the rationale in §5.5.2.
- It would let a single hostname's intermittent reclaim cause its
  jobs' `next_retry_at` to back off as if the handler itself was
  failing.

Tick reclaim therefore takes the row to `queued`, not `failed`, and
the retry scheduler is never invoked for lease-expiry rows.

§3.5.8 is the retry-scheduler-side restatement of this rule; the two
sections describe the same invariant from opposite angles. They must
stay in sync.

### 5.9 Ordering vs queue pause / drain

**Stub.** Forward-reference to the queue state machine SPEC entry
(currently unwritten — see `feedback-queue-state-machine-explicit`
memory). When pause/drain semantics land, this section will describe:

- Whether the tick reclaim runs on a queue in `paused` state.
- Whether the tick reclaim runs on a queue in `draining` state.
- How the tick interacts with the "no new claims" invariant of those
  states (tick reclaim does not claim — `TickRequeue` requeues — but
  does it count as a write the paused queue forbids?).
- Whether the inline reclaim runs at all on a paused queue (Dequeue
  itself is blocked, so this is moot in practice — note for
  completeness).

Until that SPEC entry is written, treat reclaim as ignoring queue
state — i.e., both invocation sites operate regardless of any
queue-level pause / drain flag. Document any change here BEFORE
implementing it.

### 5.10 Parameters

Reclaim has one primitive-wide parameter (applies to both invocation
sites) and three tick-driver-specific parameters.

#### 5.10.1 Primitive-wide

| Knob | Default | Bounds | Notes |
|------|---------|--------|-------|
| `reclaim_grace` | `10s` | fixed in code today (`ReclaimGraceSeconds` in `packages/queue-core/reclaim.go`); configurable is planned, not implemented | Extra time beyond `lease_expires_at` before a row becomes reclaimable. Set to absorb transient liveness disruption (worker GC pause, brief DB stall, network hiccup, noisy container scheduling) without triggering ownership flapping. The selection predicate at both sites is `status='running' AND lease_expires_at + reclaim_grace <= now()`. |

`reclaim_grace = 10s` against a lease duration of `30s` (§1.8) means a
row is reclaimable after a worker has been silent for at most 40s
since its last successful heartbeat — comfortable for typical GC /
scheduler hiccups, still short enough that fleet collapse self-heals
within ~lease_duration. If you tune the lease duration, retune the
grace proportionally.

`reclaim_grace = 0` is permitted but discouraged outside of tests; it
reverts behavior to "lease expiry == owner death" with the false-
positive reclaim churn that implies under load.

#### 5.10.2 Tick driver

Implementation: `apps/api/internal/reclaim/driver.go`. Interval and batch limit come from `VEYRA_RECLAIM_INTERVAL_SECONDS` (default 10) and `VEYRA_RECLAIM_BATCH_LIMIT` (default 100).

| Knob | Default | Bounds | Notes |
|------|---------|--------|-------|
| Tick interval | `10s` | configurable; >= 1s | Lower than the lease duration (30s, §1.8) by a comfortable margin so an expired lease is reclaimed within ~1 lease-duration in the worst case. |
| Per-tick row LIMIT | `100` | configurable; >= 1 | Bounds the per-tick transaction. Larger backlogs drain across multiple ticks. |
| Per-tick deadline | none | — | The tick does not have a deadline. If a batch takes longer than the interval, the next tick is suppressed (singleton-per-process); the scan picks up after the current batch commits. |

The tick driver MUST be singleton-per-deployment in the same way as
the retry scheduler (§3.5.5): one api process, one tick. With multiple
api replicas, wrap the tick body in a Postgres advisory lock
(`pg_try_advisory_lock`) so multiple replicas do not double-scan; see
the identical note in `apps/api/internal/workers/sweeper.go`.

#### 5.10.3 Topology independence of the primitive

The reclaim **primitive** is topology-independent. It is a pure SQL
transition over a locked row — it does not know or care whether it
was invoked from a singleton process, a partitioned reclaim fleet,
multiple HA api replicas, a dedicated reclaim service, or a shard
owner. Only the **tick driver** is constrained to
singleton-per-deployment (§5.10.2) because of the advisory-lock
model.

This separation is deliberate. Future topologies — a dedicated
reclaim service, partitioned reclaimers shard-by-queue, an HA api
with leader-elected reclaim ownership — are added by writing a new
driver that invokes the primitive on whatever scheduling discipline
they prefer. The primitive itself does not need to change, and its
SPEC clauses (§5.3 through §5.8) continue to apply unchanged.

### 5.11 Errors

- Validation errors at SQL prep time → wrapped, returned to caller. No sentinels.
- pgx errors during UPDATE / INSERT → the surrounding transaction rolls back via the caller's deferred Rollback; caller surfaces the wrapped error.
- The inline path may surface `ErrLeaseLost` from a downstream Ack / Nack / Heartbeat call on the previous attempt, but NOT from Reclaim itself.
- Tick path: per-row errors within a batch fail ONLY that row (the row's mutation is wrapped in a savepoint); the rest of the batch continues. The per-row error is recorded via the `queue.reclaim.row.failed` event (§5.12) and the failed row is left for a subsequent tick to retry.

**Note on savepoint scalability (non-blocking).** The per-row savepoint
model is operationally correct and matches the current observed
volume (single-digit reclaims per tick in expected steady state). At
hypothetical high-volume reclaim conditions — e.g., a mass-restart
event after a Postgres failover that simultaneously expires hundreds
of leases — `SAVEPOINT`-per-row adds per-row WAL overhead that may
become measurable. Future implementations MAY switch to a chunked
transactional model (batch of N rows reclaimed in one tx, whole
batch rolled back on per-row failure and individually re-tried in a
subsequent tick) if and when that overhead is empirically
demonstrated. Pick the strategy when its limits show up in a real
soak — do not cargo-cult either approach pre-emptively.

### 5.12 Observability contract

Per-row events. Both sites emit these; the `site` field
(`inline` / `tick`) distinguishes them.

| Event                                  | Level | Required fields                                                                            |
|----------------------------------------|-------|---------------------------------------------------------------------------------------------|
| `queue.reclaim.row.closed_prior`       | info  | `site`, `jobId`, `priorAttemptNumber`, `priorWorkerId`, `rowsAffected`                      |
| `queue.reclaim.row.claimed`            | info  | `site=inline`, `jobId`, `attempt`, `leaseExpiresAt`, `priorWorkerId`                        |
| `queue.reclaim.row.requeued`           | info  | `site=tick`, `jobId`, `attempt`, `priorWorkerId`                                            |
| `queue.reclaim.row.dlq`                | info  | `site`, `jobId`, `attempt`, `maxAttempts`, `priorWorkerId`                                  |
| `queue.reclaim.row.stale`              | warn  | `site`, `jobId`, `expectedAttempt`, `reason` (`recheck_failed`) — emitted when §5.4's conditional UPDATE returns `RowsAffected=0`; row was no longer reclaimable under the lock |
| `queue.reclaim.row.failed`             | error | `site`, `jobId`, `err`                                                                      |

Per-tick summary (tick only). Exactly one `queue.reclaim.tick` event
per tick, written after the batch commits.

| Event                                  | Level | Required fields                                                                            |
|----------------------------------------|-------|---------------------------------------------------------------------------------------------|
| `queue.reclaim.tick.started`           | info  | `intervalSeconds`, `rowLimit`                                                               |
| `queue.reclaim.tick.stopped`           | info  | `reason` (`canceled` / `deadline_exceeded` / other)                                         |
| `queue.reclaim.tick`                   | info  | `scanned`, `reclaimedRequeued`, `reclaimedDlq`, `stale`, `failed`, `elapsedMs`              |
| `queue.reclaim.tick_failed`            | error | `err`                                                                                       |

The legacy dequeue events `queue.dequeue.reclaim_closed_prior` and
`queue.dequeue.dlq_on_reclaim` (described in earlier revisions of
§1.11) are **superseded** by the unified `queue.reclaim.row.closed_prior`
and `queue.reclaim.row.dlq` events with `site=inline`. The
implementation MUST emit the new names. Do not emit both.

Soak-stream metrics:

- `worker_recovery_seconds` — chaos-side; container-layer recovery
  measure (SOAK_REPORT.md A1.3). Independent of the reclaim primitive.
- `reclaim_tick_lag_seconds` — DB-side; the age (in seconds) of the
  oldest expired-lease row at the start of each tick. Analogue of
  `oldest_failed_due_lag_seconds` from §3.5.5. When the tick is
  healthy, `reclaim_tick_lag_seconds <= tick_interval + lease_duration`.
  A growing value is the operator-facing signal that the tick is
  starved or down.

Names are camelCase. Implementation uses `log/slog`. Additional fields
beyond the required set are permitted.

### 5.13 Verified by

Covered:

- `TestReclaim_FleetCollapse_SelfHeals` (`packages/queue-core/reclaim_integration_test.go`).
  Runs real Postgres. Claims jobs, simulates lost leases, and checks that the
  fleet recovers and every job succeeds.

Not yet covered (each is a gap in the implementation's test suite):

- §5.4 post-lock revalidation: stale on renewed lease, status change, attempt change.
- §5.4 `ended_at IS NULL` guard prevents double closure of an attempt.
- §5.5.1 inline claim with budget remaining. §5.5.2 tick requeue leaves `attempt` and `next_retry_at` unchanged.
- §5.6 budget-exhausted dead-letter, inline and tick.
- §5.7 idempotent redundant invocation, two concurrent invocations (exactly one wins), crash mid-batch.
- §5.8 tick-reclaimed row leaves `next_retry_at = NULL`.
- §5.10 tick batch limit. Advisory-lock singleton behavior.

---

## 6. Cancel

> **Status: implemented.** Operator-initiated terminal stop for a job that
> has not yet finished successfully or dead-lettered. Cooperative for
> in-flight work — see §6.4.

Cancel stops *future* queue work on a job: it will not be dequeued,
retried, or Acked after Cancel commits. It does **not** undo side
effects already performed by a running handler (e.g. an HTTP request
that already left the worker).

### 6.1 Inputs

| Name    | Type     | Meaning                                      |
|---------|----------|----------------------------------------------|
| `jobId` | `string` | The job to cancel. Required, non-empty.      |

Optional cancel `reason` / audit-log rows are **out of scope for v1**.
The durable audit signal is the status transition itself
(`status='cancelled'`, `cancelled_at` set).

### 6.2 Outcome by prior status

Cancel locks the `jobs` row `FOR UPDATE`, then branches on `status`:

| Prior status | Result | Field writes |
|--------------|--------|--------------|
| `queued` | transition | `status='cancelled'`, `cancelled_at=now()`, `next_retry_at=NULL`, `current_worker_id=NULL`, `lease_expires_at=NULL` |
| `failed` | transition | same as queued — **must** clear `next_retry_at` (§3.5.6 / §3.5.4(1)) |
| `running` | transition | same job writes as above; **also** close the open `job_attempts` row with `outcome='cancelled'`, `ended_at=now()` (§6.4) |
| `cancelled` | **idempotent success** | no mutation; return the current row |
| `succeeded` | **reject** `ErrNotCancellable` | unchanged |
| `dead_lettered` | **reject** `ErrNotCancellable` | unchanged |
| (missing row) | **reject** `ErrJobNotFound` | — |

API-derived status `scheduled` is storage `queued` with
`scheduled_for > now()` — Cancel treats it as `queued`.

`jobs_terminal_exclusivity` and `jobs_retry_consistency` MUST hold
after every successful Cancel write.

### 6.3 Errors

| Sentinel | When |
|----------|------|
| `ErrJobNotFound` | No row with `jobId` |
| `ErrNotCancellable` | Row is `succeeded` or `dead_lettered` |

Callers map these to HTTP 404 and 409 respectively. Idempotent
re-cancel of an already-`cancelled` job is **not** an error.

### 6.4 Cooperative cancel of `running` jobs

Cancel of a `running` job is **cooperative**, not preemptive:

1. Inside the Cancel transaction: close the open attempt
   (`ended_at IS NULL`) with `outcome='cancelled'` (operator intent —
   **not** `lease_lost`), then flip the job to `cancelled` and clear
   lease ownership (`current_worker_id`, `lease_expires_at`).
2. The holding worker's next `RenewLease` fails (row no longer
   `running` / ownership cleared) → renewer cancels `jobCtx` →
   handler aborts → runtime MUST **not** Ack or Nack (existing
   worker contract). Reclaim's running/expired predicate no longer
   matches the cancelled row, so reclaim does not resurrect it.

There is no cross-process kill of the handler. An in-flight HTTP
call may still complete at the remote target; Veyra guarantees only
that the *job* will not retry and will not be Acked after Cancel
commits. Discovery latency is bounded by the lease-renewal interval
(typically ~10s).

### 6.5 Race rules

All participants use row locks / status+lease predicates. Whichever
transaction commits first wins; the loser sees a failed predicate.

- **Cancel vs Ack:** Ack-first → job `succeeded` → later Cancel
  returns `ErrNotCancellable`. Cancel-first → Ack's lease/status
  guard fails (`ErrLeaseLost`); worker abandons without writing
  success.
- **Cancel vs Nack:** Nack-first → job `failed` (retryable) or
  `dead_lettered`. A later Cancel either cancels the retry-pending
  `failed` row or returns `ErrNotCancellable` for DLQ. Cancel-first
  → Nack guard fails.
- **Cancel vs retry promote:** both lock the row; §3.5.6.
- **Cancel vs Reclaim:** after Cancel the row is not `running`;
  reclaim returns stale/skips. Attempt outcome is `cancelled`, not
  `lease_lost`.
- **Cancel vs Dequeue claim:** claim-first → later Cancel uses the
  `running` branch. Cancel-first → claim candidate predicate fails.

### 6.6 Non-goals (v1)

- Preemptive handler interrupt beyond lease-clear → renewer → `jobCtx`
- Bulk cancel
- Queue pause / drain
- DLQ replay / re-enqueue
- Cancel reason string / `audit_log` table

### 6.7 Observability

| Event | Level | Fields |
|-------|-------|--------|
| `queue.cancel.success` | info | `jobId`, `priorStatus`, `idempotent` (bool) |
| `queue.cancel.rejected` | info | `jobId`, `priorStatus`, `reason` ∈ {`not_cancellable`, `not_found`} |

### 6.8 Verified by

Integration tests in `packages/queue-core/repository_cancel_test.go`
(`go test -tags integration ./...`):

- `TestCancel_Queued` — §6.2 queued → cancelled
- `TestCancel_FailedClearsNextRetryAt` — §6.2 failed + §3.5.6
- `TestCancel_RunningClosesAttemptCancelled` — §6.4
- `TestCancel_IdempotentWhenAlreadyCancelled` — §6.2 idempotent
- `TestCancel_RejectsSucceeded` — §6.2 / §6.3
- `TestCancel_RejectsDeadLettered` — §6.2 / §6.3
- `TestCancel_NotFound` — §6.3
- `TestCancel_ThenAckFails` — §6.5 Cancel-first vs Ack

### 6.9 Enqueue (placeholder)

Enqueue is specified in §0. Cancel does not change Enqueue.

---

## 7. Failure classification — retryable vs permanent

> **Status: implemented.** Accepted 2026-10-28 (review decisions from
> 2026-06-03 retained). Normative Nack terminality lives in §3.4; this
> section owns the disposition concept, handler contract, and interactions
> with retry/reclaim.

> **Accepted review decisions (2026-06-03):**
> 1. Default disposition stays **`retry`** (§7.2 rule 1).
> 2. Permanence is a property of the **work, never the infrastructure** (§7.2
>    rule 2, §7.6).
> 3. **`dns` stays retryable** (§7.4, §7.10 case D).
> 4. **HTTP 4xx is not one class** — disposition is decided **per status code**,
>    with at minimum **408 and 429 retryable** (§7.4).
> 5. This change stays **schema-free**; a future `dead_letter_reason` column is
>    an allowed evolution but explicitly out of scope (§7.8).

### 7.1 Problem statement

Today every handler failure is **retryable**. Nack's terminality decision
(§3.4 step 2) is purely budget-based: a job dead-letters only once
`attempt >= max_attempts`. A failure that *cannot* succeed on retry — a
malformed payload, an HTTP 400 from a receiver that will reject the identical
request forever — still consumes its entire attempt budget and every backoff
interval before landing in the DLQ.

This is no longer hypothetical. The W6 real-workload exercise
(`docs/SOAK_REPORT.md`, 2026-06-03) measured the two populations directly
against the `http_request` handler and the unstable receiver:

| Failure class                              | Observed behavior on retry        | Retry value |
|--------------------------------------------|-----------------------------------|-------------|
| `http_4xx` (e.g. 400)                      | every attempt re-failed identical | **none**    |
| `invalid_payload`                          | deterministic; cannot self-heal   | **none**    |
| `dns` (bad hostname)                       | deterministic for a bad name      | low *(see §7.10)* |
| `http_5xx`                                 | recovered (`5xx→…→succeeded`)     | **high**    |
| `timeout`                                  | transient; recovered on retry     | **high**    |
| `connection_refused` / `connection`       | transient; recovered on retry     | **high**    |
| lease loss (worker death, §5)              | recovered on a different worker   | **high**    |

Evidence: scenario 2 dead-lettered a 400 only after burning 2 attempts + 2s of
backoff; scenario 3b showed `http_5xx` jobs recovering, one as late as attempt
5/5. The cost of the missing distinction is wasted attempts, wasted backoff
latency, DLQ noise that mixes "broken forever" with "ran out of luck", and —
under a downstream 4xx storm — retry-pipeline pressure that buys nothing.

The goal: let a handler declare a failure **permanent** so the engine
dead-letters it immediately, while leaving all transient failures on the
existing retry path unchanged.

### 7.2 Semantics

Introduce one concept: a failure has a **disposition**, decided by the
handler and honored by Nack.

- **`retry`** (default) — the work may succeed on a future attempt. Behavior
  is exactly today's §3.4 retryable branch + §3.5 scheduling. **Unchanged.**
- **`permanent`** — the handler asserts the work cannot succeed by being
  retried as-is. Nack dead-letters the job **immediately, regardless of
  remaining attempt budget**.

Three load-bearing rules:

1. **Default is `retry`.** Absence of any signal = retryable. This makes the
   change backward-compatible (§7.8): every existing handler and in-flight
   job keeps today's behavior until a handler opts a specific failure into
   `permanent`.
2. **Permanence is a verdict about the *work*, not the *infrastructure*.** It
   is only ever produced by a handler that ran and returned a classified
   failure (the Nack path). Lease loss, worker death, and reclaim
   (§7.7) are infrastructure events — they are *never* permanent.
3. **The engine stays handler-agnostic.** queue-core does not know that
   `http_4xx` is permanent and `http_5xx` is not. It honors a boolean the
   handler sets. Mapping failure classes → disposition is *handler policy*
   (§7.4), reviewed per handler, exactly as `workers.handlers[]` is
   observability-only and never drives engine decisions (§1.2).

### 7.3 State transitions

Nack's **terminality decision** (§3.4 step 2) is:

```
terminal  ⟺  attempt >= max_attempts  OR  disposition = permanent
```

Resulting transitions from `running` on Nack:

| Condition                                             | Target state    | `next_retry_at` |
|-------------------------------------------------------|-----------------|-----------------|
| `disposition = permanent`                             | `dead_lettered` | NULL            |
| `disposition = retry` AND `attempt >= max_attempts`   | `dead_lettered` | NULL            |
| `disposition = retry` AND `attempt <  max_attempts`   | `failed`        | set (§3.5.1)    |

The permanent dead-letter writes **exactly the same row shape** as the
budget-exhausted branch of §3.4, with one difference — the error recorded is
the handler's own `JobError` (class e.g. `http_4xx`), **not** the synthetic
`AttemptBudgetExhausted` of §5.6:

- `status = 'dead_lettered'`
- `dead_lettered_at = now()`
- `error = <handler JobError marshalled to JSONB>`
- `current_worker_id = NULL`
- `lease_expires_at = NULL`
- `next_retry_at` stays NULL (never set on this path)
- `attempt` **not** modified (consistent with §3.4's final paragraph)

The active `job_attempts` row is still closed with `outcome = 'failed'` and the
handler's `error_class`/`error_message`, identical to a retryable Nack (§3.4
step 1). **Permanence is a job-level disposition, not a new attempt outcome** —
the `attempt_outcome` enum is *not* extended (avoids a migration; see §7.8).

**Distinguishing permanent from budget-exhausted (derived, no new column):**

```
dead_lettered AND attempt <  max_attempts   ⟺  killed by a permanent failure
dead_lettered AND attempt >= max_attempts   ⟺  budget exhausted (retry or §5.6 reclaim)
```

This derived predicate is exact except for one boundary case (§7.10 case A):
a `permanent` verdict returned *on the last allowed attempt* lands with
`attempt >= max_attempts` and is indistinguishable from budget exhaustion by
attempt count alone. The observability events (§7.6) disambiguate it.

### 7.4 Handler contract changes

**Worker handler interface** (`apps/worker/internal/handler`):

`handler.Error` gains one field:

```go
type Error struct {
    Class     string
    Message   string
    Permanent bool // NEW — false (zero value) = retryable. The handler sets
                   // true only when retrying the identical work cannot help.
}
```

The zero value (`false`) preserves current behavior for every existing
construction site, so this is a source-compatible addition.

**Worker runtime** (`runtime/worker.go` `nackJob`): when the handler returns a
`*handler.Error`, propagate `herr.Permanent` into the Nack input (§7.5). Any
non-`*handler.Error` failure is treated as `Permanent=false` (retryable) — an
unclassified error is conservatively assumed transient.

**First consumer — `http_request` mapping** (handler policy, not
engine policy):

Disposition is decided **per HTTP status code**, not per `4xx`/`5xx` bucket
(accepted decision 4). The class string (`http_4xx`, …) remains the
observability grouping; the **permanent/retry decision is a separate
status-code lookup**:

| Failure                                       | Disposition  | Rationale                                  |
|-----------------------------------------------|--------------|--------------------------------------------|
| `invalid_payload`                             | **permanent**| malformed job; deterministic               |
| 4xx — **408 Request Timeout**                 | retry        | transient server-side timeout              |
| 4xx — **429 Too Many Requests**               | retry        | rate-limited; back off and retry           |
| 4xx — all **other** codes (400, 401, 403, 404, 422, …) | **permanent**| client error; identical resend will re-fail|
| 5xx — any code                                | retry        | transient (W6 evidence)                    |
| `timeout`, `connection_refused`, `connection` | retry        | transient (W6 evidence)                    |
| `dns`                                         | retry        | can flap; conservative (§7.10 case D)      |
| 3xx (not followed), other transport           | retry        | rare/ambiguous; default-safe               |

> **Hard requirement for the implementation phase** (not a suggestion): the
> permanence decision MUST be driven by the concrete HTTP status code, with an
> explicit **retryable-4xx allow-list — at minimum {408, 429}** — checked
> *before* defaulting other 4xx to permanent. The current `httpStatusClass`
> (`apps/worker/internal/handler/http_request.go`) collapses all 4xx into one
> `http_4xx` string and therefore CANNOT express this; the handler must carry
> the raw status code into its permanence decision (e.g. set `Permanent` from
> the int code, not from the coarse class). Marking the whole `http_4xx`
> bucket permanent is a **defect** — it would wrongly dead-letter rate-limited
> (429) and request-timeout (408) deliveries on the first attempt. This is
> handler-local policy and does **not** touch queue-core; it is mandated here
> so the reviewer and implementer see one unambiguous contract. The allow-list
> is expected to grow (e.g. 425 Too Early); keep it a named set, not a magic
> literal.

### 7.5 Interaction with the retry scheduler (§3.5)

**No change to the scheduler.** The scheduler's predicate is
`status='failed' AND next_retry_at IS NOT NULL` (§3.5.3). A permanent failure
goes straight to `dead_lettered` with `next_retry_at = NULL`, so it is **never
visited** by the scheduler — it cannot match the predicate.

- Invariant §3.5.4(1) (`next_retry_at` exists iff `status='failed'`) is
  upheld: the permanent path produces `(dead_lettered, NULL)`, an allowed
  combination.
- The Nack-side compute-and-store of §3.5.1 is simply **skipped** on the
  permanent branch (there is no next attempt to schedule). The
  "deterministic-after-commit" jitter invariant (§3.5.2) is untouched because
  no `next_retry_at` is written.
- A permanent failure therefore *reduces* retry-pipeline load — the opposite
  of a regression. Under a downstream 4xx storm, permanent jobs leave the
  `failed` buffer empty instead of churning it.

### 7.6 Interaction with reclaim (§5)

**No change to reclaim, and permanence never reaches it.** Reclaim fires on
**lease expiry** — a worker that died or went silent (§5). In that path there
is no handler return value, hence no disposition: the engine cannot know
whether the abandoned work would have been permanent. Per §7.2 rule 2,
infrastructure failure is always treated as transient:

- Reclaim's budget-remaining branch (§5.5) still requeues.
- Reclaim's budget-exhausted branch (§5.6) still dead-letters with
  `AttemptBudgetExhausted` (its synthetic class, distinct from a permanent
  handler class — so the two DLQ causes remain separable by `error.class`).

The boundary case "handler computed a permanent verdict but its lease was
already lost" resolves cleanly under existing rules and needs no new
mechanism — see §7.10 case B.

### 7.7 Observability / events

Extend the §3.8 Nack observability contract:

| Event                       | Level | Change                                                                 |
|-----------------------------|-------|------------------------------------------------------------------------|
| `queue.nack.recorded`       | info  | ADD field `disposition` ∈ {`retry`, `permanent`, `budget_exhausted`}   |
| `queue.dlq.permanent`       | warn  | NEW — emitted when Nack dead-letters via the permanent branch. Fields: `workerId`, `jobId`, `handler`, `attempt`, `maxAttempts`, `errorClass`. Distinguishes a permanent DLQ from a budget-exhausted one in the log stream. |
| `queue.retry.scheduled`     | info  | unchanged — still only on the retryable branch (never fires for permanent) |

W4 reporting tie-in (no new infra): the existing
`http_request_error:<class>` snapshot metric and the `queue_state.sql` §5
"failures by handler & error class" already separate permanent DLQs (handler
class, e.g. `http_4xx`) from budget-exhausted DLQs (`AttemptBudgetExhausted`)
**by error class today**. On acceptance, a one-line addition to
`scripts/soak/sql/snapshot.sql` could surface the §7.3 derived predicate
explicitly, e.g. `jobs_dlq_permanent` = count of
`dead_lettered AND attempt < max_attempts`. Optional, not required.

### 7.8 Migration impact

- **No schema migration required.** The disposition is *transient* — it flows
  handler → Nack and determines the transition; the resulting row state already
  encodes it (§7.3 derived predicate + `error.class`). No new column, no new
  enum value, no `attempt_outcome` change.
- **No data backfill.** Existing `failed`/`dead_lettered` rows keep their
  meaning. There is no reinterpretation of historical data.
- **Backward compatible by construction.** Default `retry` (§7.2 rule 1) means
  the `noop` handler, any unclassified error, and every in-flight job behave
  exactly as today. The change is inert until a handler sets `Permanent=true`.
- **CHECK constraint forward-path.** §3.5.4(1) is slated to become a schema
  `CHECK (next_retry_at IS NOT NULL) = (status='failed')`. The permanent path
  produces `(dead_lettered, next_retry_at NULL)`, which satisfies that future
  constraint — so this proposal does not block it.
- **Allowed future evolution — `dead_letter_reason` (out of scope here).** This
  change stays schema-free (accepted decision 5). It is, however, explicitly
  anticipated that reporting/analytics may eventually want first-class,
  queryable differentiation between terminal outcomes rather than the §7.3
  derived predicate + `error.class` heuristic. When that need is concrete, a
  `dead_letter_reason` column (an enum) is an **allowed additive evolution**.
  Its value space should at least distinguish:
  - `permanent` — handler verdict (this proposal, §7.3);
  - `budget_exhausted` — ran out of attempts on a retryable failure (§3.4 /
    §5.6 reclaim);
  - `operator_action` — a future operator-initiated move-to-DLQ (depends on
    operator semantics, not yet specified);
  - room for further terminal causes (e.g. cancellation) as they are specified.

  This is a **separate migration and an explicit follow-up**, gated on a real
  reporting need — it is NOT part of this change, and §7 must not be
  implemented as if the column exists.

### 7.9 Inputs (delta to §3.1)

Nack's input (`FailParams`) gains one optional field:

| Name        | Type   | Meaning                                                                 |
|-------------|--------|-------------------------------------------------------------------------|
| `permanent` | `bool` | Default `false`. When `true`, Nack takes the permanent branch (§7.3) regardless of attempt budget. Sourced from `handler.Error.Permanent`. |

Preconditions (§3.2), locking (§3.3), idempotency (§3.6), and errors (§3.7) are
**unchanged** — a permanent Nack is still a Nack: it requires lease ownership,
holds the same row lock, and replaying it on an already-terminal job is the
same no-op/guard-failed path as any Nack.

### 7.10 Edge cases

**A. Permanent on the last allowed attempt** (`attempt == max_attempts`).
The job dead-letters via the permanent branch, but lands with
`attempt >= max_attempts`, so the §7.3 *attempt-count* heuristic reads it as
budget-exhausted. Defined behavior: still dead-lettered with the handler's
`error.class` (not `AttemptBudgetExhausted`), and `queue.dlq.permanent` is
emitted — the **event + error class** are authoritative; the attempt-count
predicate is a convenience, not the source of truth.

**B. Permanent verdict computed after lease loss.** A handler may finish and
decide "permanent" only to find its lease already expired (worker paused,
renewal failed). Per §4.5 the worker MUST abort on renewal failure and per the
runtime contract a cancelled `jobCtx` means **no Nack is sent** (reclaim owns
the row). Even if a Nack were attempted, §3.2 preconditions reject it with
`lease_lost`/`lease_expired`. Net: the permanent verdict is **discarded**, and
the job follows the reclaim path as transient (§7.6). This is intentional —
once the infrastructure has taken the job back, the handler's verdict about
*that* attempt no longer applies; the work will be re-judged on the next
attempt.

**C. Over-eager permanence (handler bug).** A handler that marks a genuinely
transient failure `permanent` causes premature dead-lettering. Mitigations,
all already present: (1) default is `retry`, so this requires an explicit
mistake; (2) per-handler classification is reviewed like any code; (3) the W4
DLQ-by-class surface (§7.7) makes a spike of permanent DLQs in a normally
transient class immediately visible. No engine guardrail is proposed — the
engine cannot second-guess a handler's verdict without re-introducing
handler-specific policy into queue-core (§7.2 rule 3).

**D. DNS treated as retryable.** W6 framed `dns` as "deterministically
permanent for a bad hostname", but DNS resolution genuinely flaps (resolver
restarts, propagation, transient `SERVFAIL`). The `http_request`
mapping (§7.4) classifies `dns` as **retry** — the conservative choice, since
the cost of retrying a truly-dead name is bounded by `max_attempts` while the
cost of permanently dead-lettering a name that was briefly unresolvable is a
lost job. Revisit only if evidence shows DNS-permanent dominates.

**E. `http_4xx` is too coarse to be uniformly permanent.** 408 and 429 are 4xx
but retryable (§7.4). Marking all `http_4xx` permanent would wrongly kill
rate-limited deliveries. The handler MUST distinguish these before setting
`Permanent`; the engine is unaffected either way.

**F. Permanent + queue paused/draining.** Out of scope — pause/drain semantics
are not yet specified (§ Operations table, Cancel/pause "not started").
When they are, this section must be revisited for the interaction.

### 7.11 Verified by

Integration tests in `packages/queue-core/repository_complete_test.go`
(`go test -tags integration ./...`):

- `TestNack_Permanent_DeadLettersWithBudgetRemaining` — §7.3 row 1
  (permanent short-circuits a job with `attempt < max_attempts`).
- `TestNack_Permanent_PreservesHandlerErrorClass` — §7.3 (error class is the
  handler's, not `AttemptBudgetExhausted`).
- `TestNack_Permanent_NoNextRetryAt_SchedulerNeverPromotes` — §7.5 +
  invariant §3.5.4(1).
- `TestNack_Retry_DefaultUnchanged` — §7.2 rule 1 (absence of signal =
  today's retryable behavior).
- `TestReclaim_BudgetExhausted_NeverPermanent` — §7.6 (reclaim DLQ uses
  `AttemptBudgetExhausted`, not a permanent disposition).
