# packages/queue-core

**The queue.** Semantics live here. Everything else (apps/api, apps/worker) consumes this package.

## The one rule

**Queue semantics are documented before they are implemented.**

If you are about to change behavior of any of the following, you must update `SPEC.md` (in this directory) **first**, then implement, then test against the spec:

- `Enqueue` — when a job becomes visible, ordering guarantees, deduplication.
- `Dequeue` / `Lease` — visibility, lease duration, concurrent dequeue safety.
- `Ack` — what "done" means, when a job is removed.
- `Nack` / `Fail` — retry scheduling, attempt counting, dead-letter triggers.
- `Heartbeat` / `ExtendLease` — lease extension semantics, max extension.
- `Timeout` — what happens when a lease expires with no heartbeat.
- `Cancel` — SPEC §6. Cooperative stop from queued/failed/running; idempotent if already cancelled; rejected if succeeded/dead-lettered.
- `Priority` / `Scheduling` — ordering across queues, delay semantics.

This rule exists because the worker, the API, the retry layer, and the operator UI all reason about jobs based on the *spec*, not the code. If the spec and the code disagree, every consumer is silently wrong. See [docs/decisions/0004-queue-semantics-documented-before-implementation.md](../../docs/decisions/0004-queue-semantics-documented-before-implementation.md).

## Conventions

- **All public behavior is testable from the spec.** Each spec section names the test file that exercises it.
- **PostgreSQL is the substrate.** Locking uses `FOR UPDATE SKIP LOCKED`. Visibility uses a `visible_at` column. Lease ownership uses a `leased_by` + `lease_expires_at` pair. Any deviation needs an ADR.
- **No external dependencies in this package.** Standard library + `pgx`. Nothing else.
- **Errors are typed.** Callers branch on `errors.Is(err, queuecore.ErrLeaseExpired)`, never on strings.

## Files

- `SPEC.md` — the authoritative spec. (Create this before the first non-trivial change.)
- `*.go` — implementation.
- `*_test.go` — tests, each referencing the spec section under test.

## When the spec doesn't yet cover something

You are designing new semantics. Stop, write the spec section, get it reviewed, *then* code. If a reviewer (human or AI) cannot point at the spec line that justifies the code, the code should not be merged.
