# 0002 — PostgreSQL as the Primary Store and the Queue

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Veyra core
- **Supersedes:** —

## Context

A job queue and workflow orchestrator needs two things: durable storage for jobs and their state, and a queueing primitive that supports enqueue / dequeue / lease / ack semantics under concurrent consumers.

The conventional split is "use Postgres for state and Kafka/Redis/RabbitMQ for the queue." That split has real costs:

- Two systems to operate, monitor, secure, back up, and reason about.
- Two consistency models — the queue and the store can disagree.
- Distributed transactions or outbox patterns to keep them in sync.
- Operators have to learn two query languages and two failure modes.

Modern PostgreSQL (14+) supports `FOR UPDATE SKIP LOCKED`, which gives correct, concurrent dequeue semantics from a plain table. At the scale Veyra needs to be correct at first (single-digit thousands of jobs/sec), Postgres is more than sufficient.

## Decision

PostgreSQL is the **only** durable system in Veyra. It is the queue, the job store, the lease store, the audit log, and the workflow state machine. There is no Kafka, no Redis, no RabbitMQ, no separate message bus.

Dequeue uses `SELECT ... FOR UPDATE SKIP LOCKED`. Leases are a column pair on the job row (`leased_by`, `lease_expires_at`). Retry scheduling is a `visible_at` timestamp. Dead-letter is a status transition, not a separate topic.

## Consequences

### Positive
- One system to operate, monitor, and back up.
- Queue state and job state share transactions — no outbox, no dual-write, no eventual consistency between "the job was queued" and "the job exists."
- Operators inspect, drain, replay, and pause via SQL. The operator UX problem becomes "write good SQL views and admin endpoints," which is well-understood.
- Backups, point-in-time-recovery, and replication all come for free from Postgres.

### Negative
- Postgres throughput will become the bottleneck before per-broker throughput would in a Kafka setup. We accept this; if and when we hit it, we revisit via an ADR.
- Some queue patterns (fan-out to many consumers, infinite retention as an event log) are awkward in Postgres. We accept this; those are not our use cases.

### Neutral / follow-ups
- We will tune `autovacuum` carefully on queue tables — high-churn tables need aggressive settings.
- A future ADR may add a read replica for analytics queries to keep the primary's write path clean.

## Alternatives considered

- **Kafka for the queue + Postgres for state.** Rejected — see "two systems" above, plus we do not need partitioned, replayable, infinite-retention event semantics.
- **Redis (BullMQ, Resque-style).** Rejected — persistence is best-effort, recovery semantics are weaker than Postgres, and we'd still need Postgres for state.
- **A single-node embedded queue (Litestream + SQLite).** Rejected — does not support the concurrent dequeue and operational tooling Postgres provides.

## References

- PostgreSQL: [`FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).
