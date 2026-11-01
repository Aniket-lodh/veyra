# Job lifecycle

This is a summary. The authoritative rules are in
[`packages/queue-core/SPEC.md`](../../../../packages/queue-core/SPEC.md), and the
column-level reasoning is in
[`docs/architecture/database-schema.md`](../../../../docs/architecture/database-schema.md).

## Storage states

`jobs.status` holds six values: `queued`, `running`, `succeeded`, `failed`,
`dead_lettered`, and `cancelled`.

The API also reports a derived `scheduled` state. It means `queued` with a
`scheduled_for` time in the future.

## Transitions

```
enqueue ──▶ queued ──dequeue──▶ running ──ack──────────▶ succeeded
                ▲                  │
                │                  ├──nack (retryable, budget left)──▶ failed ──(next_retry_at due)──▶ queued
                │                  │
                │                  ├──nack (permanent or budget exhausted)──▶ dead_lettered
                │                  │
                │                  └──lease expired──▶ reclaimed ──▶ queued or dead_lettered
                │
queued / failed / running ──cancel──▶ cancelled
```

- `dequeue` increments `attempt` and inserts a `job_attempts` row.
- A worker that loses its lease must stop. It must not ack or nack.
- `cancel` is idempotent on `cancelled`. It is rejected on `succeeded` and `dead_lettered` (HTTP 409).

## Attempt outcomes

Each `job_attempts` row ends with one of: `succeeded`, `failed`, `timeout`,
`cancelled`, or `lease_lost`. The API renders `lease_lost` as `lease-lost`.
