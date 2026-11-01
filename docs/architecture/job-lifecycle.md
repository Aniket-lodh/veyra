# Job lifecycle

This is a summary. The normative rules are in
[`packages/queue-core/SPEC.md`](../../packages/queue-core/SPEC.md). The column-level
reasoning is in [`database-schema.md`](database-schema.md).

## Storage states

`jobs.status` holds six values: `queued`, `running`, `succeeded`, `failed`,
`dead_lettered`, and `cancelled`.

The API also reports a derived `scheduled` state. It means `queued` with a
`scheduled_for` time in the future. The API renders `dead_lettered` as
`dead-lettered`.

## Transitions

```
enqueue ──▶ queued ──claim──▶ running ──ack──────────────────────▶ succeeded
               ▲                 │
               │                 ├──nack, retryable, budget left──▶ failed
               │                 │                                   │
               │                 │        (next_retry_at due, promoted by the scheduler)
               └─────────────────┼───────────────────────────────────┘
                                 │
                                 ├──nack, permanent or budget spent──▶ dead_lettered
                                 │
                                 └──lease expired, reclaimed──▶ queued (tick)
                                                             or claimed again (inline)
                                                             or dead_lettered (budget spent)

queued | failed | running ──cancel──▶ cancelled
```

Rules that matter for operators and handler authors:

- A claim increments `attempt` and inserts a `job_attempts` row. The attempt is
  open until it is closed by ack, nack, cancel, or reclaim.
- Only the worker that holds the lease can ack or nack. If the lease was lost, the
  call is rejected (`ErrLeaseLost` or `ErrLeaseExpired`). The worker must not retry
  the call.
- A tick reclaim requeues the job without incrementing `attempt`. The attempt is
  closed with `outcome='lease_lost'`.
- `cancel` is idempotent on `cancelled`. It is rejected with HTTP 409 on
  `succeeded` and `dead_lettered`.
- Dequeue selects only jobs whose handler the worker runs. Among those, it selects
  `queued` rows that are due, and `running` rows whose lease has expired. A job with no
  capable worker stays `queued` until one appears. A `failed` row becomes `queued` only when the scheduler promotes it.

## Attempt outcomes

Each `job_attempts` row ends with one of `succeeded`, `failed`, `timeout`,
`cancelled`, or `lease_lost`. The API renders `lease_lost` as `lease-lost`.

## Failure classes

Handlers report failures with a class. The worker sends the class with the nack.
The class is stored on the attempt and on the job's `error`. Whether a failure is
retried depends on its class. The worker's failure classes are documented in
`apps/worker/CLAUDE.md`, and the retry rules are in SPEC §7.
