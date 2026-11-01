# Runbook: worker stuck

**Audience:** the on-call operator. You have shell access to the host running
the compose stack and read access to the dashboard.

**Symptom (what the user sees):**
- A job sits in `running` and never finishes.
- A worker row shows `active` in the Workers View but isn't picking up new
  jobs from a queue with depth > 0.
- Dashboard "In flight" count is non-zero, but throughput is zero.

This runbook covers the three things that look the same from outside but
mean very different things underneath. Diagnose in order.

---

## 0. Reset to a known frame

Before anything else, capture the moment-in-time state so any rollback or
escalation has data to point at. **Don't skip this** — it takes 20 seconds
and prevents "what did the system look like when you noticed?" gaps later.

```bash
# In a tmux pane or a saved logfile:
docker compose ps
docker compose -f deployments/compose/docker-compose.yml \
  -f deployments/compose/docker-compose.prod.yml ps   # if on prod stack

docker compose exec postgres psql -U veyra -d veyra -f - <<'SQL'
\echo === workers ===
SELECT id, hostname, state,
       last_heartbeat_at,
       now() - last_heartbeat_at AS silent_for,
       heartbeat_interval_seconds
FROM workers
ORDER BY last_heartbeat_at DESC;
\echo === running jobs ===
SELECT id, queue, handler, current_worker_id,
       attempt, max_attempts,
       lease_expires_at,
       lease_expires_at - now() AS lease_in
FROM jobs WHERE status = 'running'
ORDER BY lease_expires_at;
\echo === queue depths ===
SELECT queue, count(*)
FROM jobs WHERE status = 'queued' AND scheduled_for <= now()
GROUP BY queue;
SQL
```

The output of this block is what you paste into the incident channel if
this turns out to be bigger than a one-worker problem.

---

## 1. Worker process is alive but the job handler is hung

**Tell:** the worker's heartbeat is fresh (`silent_for` < `3 × heartbeat_interval`),
its row says `active`, but the lease on its current job keeps getting
renewed (you can see `lease_expires_at` advancing).

This is *not* a sweeper problem and not a queue problem. The worker is
healthy and confidently renewing a lease on a handler invocation that
isn't returning.

### Diagnose

```bash
# Find the container for that worker (match by hostname)
docker compose ps worker

# Get a goroutine stack dump if you've enabled debug — or strace it:
docker compose exec worker-N sh -c 'kill -QUIT 1'   # if your binary handles SIGQUIT
docker compose logs --tail 200 worker-N | grep -E 'job.start|job.renew|job.success'
```

### Remediate

1. Restart that one worker container (`docker compose restart worker-N`).
   On restart, the renewer goroutine stops. Within ~30 seconds the lease
   on that hung job expires. A surviving worker dequeues it via the
   reclaim branch and tries the handler again.
2. If the same handler hangs repeatedly across workers, the handler has a
   bug — disable the handler at the worker (env var) until fixed.

**Why this works:** the queue is correct under arbitrary process death.
Killing one worker hands work back to the pool; it does not lose work.

---

## 2. Worker process is dead but the row still says `active`

**Tell:** `silent_for` > `heartbeat_interval × 3` and the row still shows
`active` or `idle`.

### Expected behaviour

The API's stale-worker sweeper runs every `VEYRA_SWEEPER_INTERVAL_SECONDS`
(default 10s). It will transition this row to `disconnected` on its next
tick. You should see a log line in the API container:

```
worker.sweeper.disconnected
  workerId=...
  hostname=...
  staleForSeconds=N
  reason=heartbeat_timeout
```

### If the row does NOT transition within ~20 seconds

Then the sweeper is not running. Verify:

```bash
docker compose logs api | grep worker.sweeper
# Expect: worker.sweeper.started intervalSeconds=10 on api boot
# Expect: worker.sweeper.disconnected events for any stale row
```

If `worker.sweeper.started` never appears, the API restarted recently with
a bad config or a SQL error. Check `docker compose logs api | tail -80`.

If `worker.sweeper.tick_failed` appears repeatedly, the DB connection is
unhealthy from the api's perspective. Check `docker compose exec api
sh -c 'wget --spider --quiet http://127.0.0.1:8008/health'`. If degraded,
follow the `postgres-restart.md` runbook (TBD).

### What about the jobs that worker was holding?

You do nothing. The dequeue path reclaims them. Specifically, when any
surviving worker calls dequeue, its SELECT predicate picks up rows where
`status='running' AND lease_expires_at <= now()`, closes the prior
attempt with `outcome='lease_lost'`, increments the attempt counter, and
re-claims the row under the new worker's ULID. This is the spec-pinned
behaviour in `packages/queue-core/SPEC.md §1.5`.

**You do not run a manual reclaim script.** Reclaim is exclusive to the
dequeue path. Manual SQL updates to `current_worker_id` or
`lease_expires_at` are how you create silent data corruption.

### Edge case: budget exhausted on reclaim

If the dead worker was on its last attempt (`attempt >= max_attempts`),
the reclaim branch DOES NOT retry — the row is dead-lettered in place
with `error.class='AttemptBudgetExhausted'`. This is intentional. See
queue-core §1.5.2. Operator action: inspect why the handler took the full
budget without succeeding (probably a real handler bug); replay from DLQ
once fixed (replay capability not yet shipped).

---

## 3. All workers stopped claiming and queue depth is growing

**Tell:** `last_heartbeat_at` is fresh for every worker, but queue depth
keeps climbing. Workers look alive but aren't picking up work.

This is almost never a worker problem. It is usually:

### 3a. The DB is rejecting new connections

```bash
docker compose exec postgres pg_isready -U veyra -d veyra
docker compose exec postgres psql -U veyra -d veyra -c \
  "SELECT count(*), state FROM pg_stat_activity WHERE datname='veyra' GROUP BY state;"
```

If `idle in transaction` is high or `active` is at `max_connections`, the
queue is starved on connections. Reduce worker concurrency or raise
`max_connections`.

### 3b. The workers are subscribed to a different queue than the jobs

```bash
docker compose exec postgres psql -U veyra -d veyra -c \
  "SELECT id, hostname, queues, handlers FROM workers WHERE state IN ('active','idle');"
```

If `queues` is `{default}` but jobs are being enqueued on `priority`, no
worker is eligible. Either:
- Re-enqueue on `default`, OR
- Scale up workers with the correct queue subscription
  (`VEYRA_WORKER_QUEUES=priority docker compose up -d worker`).

### 3c. The api/migration ran a schema change that broke dequeue

Unlikely but worth a glance at the most recent commit. If the dequeue SQL
changed and you're rolling back, follow the standard rollback procedure.

---

## When to escalate

- Sweeper is running but rows are staying `active` AND surviving workers
  are not reclaiming. That's a queue semantic failure, not an ops
  problem — open an issue with the data from §0.
- DLQ count for a single handler grows by >100 in <5 minutes. Pause the
  enqueuer for that handler (the pause mechanism is TBD; for now, set the
  handler to error early at the source).

---

## Related

- `SPEC.md §1.5` — reclaim of expired leases
- `apps/api/internal/workers/sweeper.go` — sweeper implementation; hard
  constraints in the file header
- `MEMORY.md` (auto-memory) — "Worker IDs are ephemeral runtimes"; "No
  JOIN to workers in dequeue"
