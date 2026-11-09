# 0009 — Operator live updates via SSE + Postgres NOTIFY

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Veyra core
- **Related:** [ADR-0002](0002_postgresql-as-primary-store-and-queue.md),
  [ADR-0005](0005_use-fiber-for-api-router.md),
  [ADR-0008](0008_operator-sessions-and-dashboard-api-keys.md)

## Context

The operator console refreshed queue stats, workers, and job lists by polling
REST every few seconds. That works for a demo and burns load for every open
tab even when the queue is idle.

We need push-style updates that:

1. Work the same locally (Vite same-origin proxy) and behind the prod nginx
   front door.
2. Stay Postgres-first — no Redis, NATS, or Kafka.
3. Keep REST as the payload contract (TanStack Query stays authoritative).
4. Do **not** change worker dequeue. Workers still poll; that boundary is
   intentional (see `docs/architecture/database-schema.md`).
5. Survive reconnects without silent gaps (revision + resync).

## Decision

### Transport

1. **SSE invalidation bus.** `GET /events` is an authenticated
   `text/event-stream`. It sends lightweight invalidation frames naming
   resources (`jobs`, `workers`, `stats`), not full snapshots. The browser
   invalidates TanStack Query keys and refetches the existing REST endpoints
   once per change.
2. **Same-origin only** for the console. Session cookies authenticate the
   stream. Native `EventSource` is the client. Machine callers keep using REST;
   they do not need SSE.

### Change detection

3. **Postgres NOTIFY.** Statement-level triggers on `jobs` / `workers` call
   `pg_notify('veyra_ui', resource)`. The API holds a **dedicated** `LISTEN`
   connection (not borrowed from the query pool).
4. **Column filters.** Job lease renewals (`lease_expires_at` alone) do not
   notify. Worker heartbeats (`last_heartbeat_at`) do not notify — only
   structural roster changes.

### Coalescing revision bus

5. NOTIFY bursts are **coalesced** into a dirty-set. A short flush window
   (~50–100ms) collapses many notifies into one SSE frame.
6. Every frame carries a monotonic **`revision`** used as the SSE `id`.
7. Wire format:

   ```text
   id: 42
   event: invalidate
   data: {"v":1,"revision":42,"resources":["jobs","stats"],"at":"..."}

   id: 43
   event: resync
   data: {"v":1,"revision":43,"resources":["jobs","workers","stats"],"at":"..."}
   ```

8. On connect/reconnect: if `Last-Event-ID` is missing or behind the hub
   revision, emit **`resync`** (full resource set), then continue. Clients
   must not assume they saw every intermediate invalidate.
9. Heartbeat SSE comments keep proxies alive; they do not invalidate queries.
10. Slow subscribers keep the **latest** coalesced frame (latest-wins), never
    silently drop without a later resync path.

### Failure UX

11. While the stream is down for a sustained period, the console may enable a
    slow safety refetch and must show that live updates are paused. Silent
    fake-realtime polling is not acceptable.

## Consequences

### Positive

- Idle tabs stop hammering REST.
- Multi-api-instance safe: NOTIFY is database-scoped.
- Reconnects are correct by construction (revision + resync).
- No new infrastructure dependency.

### Negative — accepted knowingly

- One dedicated Postgres connection per api process for `LISTEN`.
- Triggers add a small cost on write paths; statement-level + column filters
  keep that bounded.

### Neutral / follow-ups

- Worker dequeue still polls. Promoting LISTEN into the worker loop would be
  a separate ADR and a SPEC change.
- Pushing full snapshots over SSE is deferred; invalidation + REST is enough.
