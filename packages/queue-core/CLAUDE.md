# packages/queue-core

The queue. Queue semantics and their SQL live here. `apps/api` and `apps/worker` import this package and contain no queue logic of their own.

## The one rule

**Queue semantics are documented before they are implemented.**

If you change the observable behavior of any of these operations, update
[`SPEC.md`](SPEC.md) first, then implement, then test against the spec:

- Enqueue (`Create`): visibility, idempotency, ordering.
- Dequeue (`ClaimNextJob`): selection predicate, ordering, locking, lease.
- Ack (`MarkJobSucceeded`), Nack (`MarkJobFailed`): terminality, attempt accounting, retry scheduling.
- Lease renewal (`RenewLease`): guard, extension.
- Reclaim (`Reclaim`): transitions for expired leases, the DLQ trigger, and both invocation sites.
- Cancel (`Cancel`): outcome by prior status, races.
- Failure classification: permanent versus retryable.
- Priority, scheduling, and delayed visibility.

The worker, the API, the retry layer, and the operator console reason from the spec.
If the spec and the code disagree, the code is the bug. See
[ADR-0004](../../docs/decisions/0004_queue-semantics-documented-before-implementation.md).

## Conventions

- **PostgreSQL is the substrate.** Dequeue locks with `FOR UPDATE SKIP LOCKED`. Visibility
  uses `scheduled_for`. Lease ownership uses `current_worker_id` and `lease_expires_at`.
  Any deviation needs an ADR.
- **Timestamps come from the database.** Use `now()` in SQL. Do not pass Go clock values in.
- **Runtime dependencies:** the standard library and `pgx` only. Test-only dependencies
  (testcontainers and golang-migrate, under the `integration` build tag) are allowed.
- **Errors are typed.** Callers branch with `errors.Is(err, queuecore.ErrLeaseExpired)`. Never match on strings.
- **Lease guard.** Every write that changes a running job checks
  `current_worker_id = $worker AND status = 'running'`, and `lease_expires_at > now()` where the spec requires it.
- **Observability.** Each operation emits the events its SPEC section lists, using `log/slog`
  with camelCase field names.

## Files

- `SPEC.md`: the authoritative semantics. Each section names the tests that cover it, and lists known gaps.
- `repository.go`: `Create`, `GetByID`, `List`, `Count`, `ClaimNextJob`, `MarkJobSucceeded`,
  `MarkJobFailed`, `RenewLease`, `QueueStats`, `ListRunningLeases`, and the sentinel errors.
- `reclaim.go`: the reclaim primitive shared by the inline and tick call sites.
- `cancel.go`: `Cancel`.
- `backoff.go`, `model.go`: retry delay math and the public types.
- `testsupport/`: Postgres testcontainer helper, behind the `integration` build tag.
- `*_test.go`: unit tests (`backoff_test.go`) and integration tests (build tag `integration`).

## Tests

```bash
go test ./...                          # unit tests
go test -tags integration -count=1 ./... # real Postgres via testcontainers (needs Docker)
```

Tests for queue behavior name the spec section they verify. A test that exercises
behavior the spec does not describe is a sign that the spec needs updating.

## When the spec does not cover something

Stop and write the spec section first. Get it reviewed. Then write the code. If a
reviewer cannot point to the spec line that justifies the code, the code should not merge.
