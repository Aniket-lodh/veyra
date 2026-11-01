# Runbook: retry storm

**Audience:** the on-call operator. The dashboard is showing a sudden,
sustained spike in `running` or `failed` counts, and either DLQ is
growing or downstream is being hammered.

**Symptoms (what the user sees):**

- The dashboard's DLQ and failed counts are climbing fast.
- A specific queue's `inFlight` is at ceiling and stays there.
- Workers are claiming jobs as fast as they finish; throughput is high
  but goodput (succeeded-per-minute) is low.
- Downstream services that the handler talks to are reporting elevated
  error rates.

This is the most operationally dangerous failure mode for any queue
system. The single most important thing to know up front:

> **Jitter is working.** SPEC §3.5.2 spreads retries across `[0.5×,
> 1.5×]` of the computed backoff. You will NOT see all retries land at
> exactly the same instant. You WILL see clusters separated by ~the
> base backoff. That is correct behavior — do not assume the jitter is
> broken.

---

## 0. Capture state before doing anything

```bash
docker compose exec postgres psql -U veyra -d veyra -f - <<'SQL'
\echo === retry pipeline depth ===
SELECT status,
       count(*),
       min(coalesce(next_retry_at, completed_at, enqueued_at)) AS oldest_event
FROM jobs
WHERE status IN ('queued', 'running', 'failed', 'dead_lettered')
GROUP BY status
ORDER BY status;

\echo === retry-due NOW ===
SELECT count(*)              AS rows_due,
       min(next_retry_at)    AS oldest_due,
       now() - min(next_retry_at) AS oldest_due_lag
FROM jobs
WHERE status = 'failed'
  AND next_retry_at IS NOT NULL
  AND next_retry_at <= now();

\echo === handler that is failing the most (last hour) ===
SELECT j.handler,
       count(*) FILTER (WHERE a.outcome = 'failed')      AS failed_attempts,
       count(*) FILTER (WHERE a.outcome = 'succeeded')   AS succeeded_attempts,
       count(*) FILTER (WHERE a.outcome = 'lease_lost')  AS lease_lost_attempts
FROM job_attempts a
JOIN jobs j ON j.id = a.job_id
WHERE a.started_at >= now() - INTERVAL '1 hour'
GROUP BY j.handler
ORDER BY failed_attempts DESC
LIMIT 10;

\echo === error class distribution (last hour) ===
SELECT a.error_class, count(*)
FROM job_attempts a
WHERE a.started_at >= now() - INTERVAL '1 hour'
  AND a.outcome = 'failed'
GROUP BY a.error_class
ORDER BY count DESC
LIMIT 10;
SQL
```

Paste the output into the incident channel. The "handler failing the
most" and "error class distribution" tables are usually enough to
identify the root cause in the first 30 seconds.

---

## 1. Decide the kind of storm

There are three distinct storm shapes. Mistaking one for another is
how operators make the wrong call.

| Symptom | Storm type | Root cause |
|---|---|---|
| One handler dominates failed attempts; one error class dominates | **Handler bug** | A specific handler is failing every attempt. Retries are doing their job — escalating to DLQ — but the upstream service or your handler code is broken. |
| Many handlers failing; many error classes; one downstream service spiking | **Downstream outage** | A shared dependency (Stripe, Slack, your own DB) is degraded. Retries are stacking up while the outage resolves. |
| Failed counts oscillating up-and-down on a periodic cadence | **Synchronised retry waves** | Jitter is doing its job, but the base backoff is short enough that waves still align loosely. Almost never harmful — leave alone. |

---

## 2. Storm type: handler bug

**Tell:** §0 query 3 shows ONE handler dominating; §0 query 4 shows ONE
error class dominating.

The retry pipeline is working correctly — it is dutifully retrying a
job that will never succeed. Your goal is to stop the bleeding without
losing data.

### Diagnose

```bash
# Look at a recent failed attempt's full error
docker compose exec postgres psql -U veyra -d veyra -c "
  SELECT id, handler, error
  FROM jobs
  WHERE handler = 'OFFENDING_HANDLER'
    AND status IN ('failed', 'dead_lettered')
  ORDER BY enqueued_at DESC
  LIMIT 1;
"
```

The `error` column has the full structured error written by the worker.
That tells you the class, the message, and the occurred_at.

### Remediate

In rough priority order:

1. **Fix the handler.** Deploy the fix. The retry pipeline will
   naturally drain as fixed attempts succeed.
2. **If fix is not imminent, stop the bleeding at the source.** If
   you're enqueueing the buggy job from another service, pause that
   service's enqueueing first — every new bad enqueue costs you
   `max_attempts × backoff_cap` seconds of pointless work.
3. **DO NOT manually UPDATE next_retry_at to defer retries.** That
   violates SPEC §3.5.2's deterministic-after-commit invariant. Cancel
   the affected jobs (cancel endpoint TBD; for now, you can manually
   set `status='cancelled', cancelled_at=now(), next_retry_at=NULL` in
   psql — but document every row you touched in the incident channel).

### What NOT to do

- Don't restart the api hoping it'll "clear the retry queue." The
  retry pipeline is durable in the rows — restart only delays
  promotion by one scheduler tick. Nothing is cleared.
- Don't restart workers. They're behaving correctly; the work is
  bad. Restarting just hands the work to a different worker for the
  same outcome.
- Don't `TRUNCATE jobs` or `DELETE FROM jobs WHERE status='failed'`.
  This loses the audit trail and any in-flight jobs that haven't
  finished. Cancel is the supported escape hatch.

---

## 3. Storm type: downstream outage

**Tell:** §0 query 3 shows MANY handlers failing in roughly even
proportion; §0 query 4 shows error classes typical of network /
infrastructure failures (`ConnectionRefused`, `Timeout`, `5xx`).

The queue is fine. Retries are stacking up while a shared dependency
is degraded. Your job is to wait without making it worse.

### Diagnose

You already know which downstream is degraded from query 4. Confirm
out-of-band (status page, Grafana, pingdom). If it's your own service,
follow that service's runbook.

### Remediate

1. **Watch `oldest_failed_due_lag_seconds`** (soak snapshot metric):
   - Hovering near the scheduler interval (5s default) = scheduler
     keeping up. Good.
   - Growing steadily = scheduler is throughput-limited by
     `batchLimit`. Either bump `VEYRA_RETRY_BATCH_LIMIT` (default
     256) or accept the lag — the work is durable, just slow.
2. **Verify dequeue is keeping up.** If `running` count is at worker
   capacity but the downstream is still degraded, your retries are
   wasting worker capacity on certain-failure. Consider pausing the
   affected handler (mechanism TBD) until downstream recovers.
3. **Watch the DLQ growth rate.** Jobs reaching `max_attempts` during
   an outage end up dead-lettered. If your max_attempts is too low,
   transient outages cost you data. Bump max_attempts for the
   affected handlers if this turns out to be a recurring pattern.
4. **Do NOT manually re-enqueue dead-lettered jobs while the outage is
   ongoing.** They will retry, hit max_attempts, and DLQ again,
   doubling the audit log. Wait for downstream recovery, then bulk
   replay (mechanism TBD).

### When to escalate

- `oldest_failed_due_lag_seconds` keeps growing AND batch limit is
  already at 1024+. The scheduler is genuinely starved; this is
  unusual at any reasonable load.
- DLQ growth rate > 10% of total job throughput for more than 10
  minutes. Either max_attempts is too low or the downstream outage
  is total. Operator decision required: pause enqueueing entirely,
  or accept the DLQ growth and plan a bulk replay.

---

## 4. Storm type: synchronised waves

**Tell:** failed count oscillates on a periodic cadence matching ~the
job's base backoff. The downstream is fine; specific handlers are
not dominating.

This is almost always benign. Full jitter spreads retries across
`[0.5×, 1.5×]` of the base — for a 30-second base that means a 30-
second wave width. If everything's working, you'll see a soft
sinusoid on the failed-count chart, not a sharp spike.

**Action:** none. Document the cadence in the soak run notes.

If the waves are uncomfortably sharp — e.g. you see literal vertical
spikes in `inFlight` — that's a signal that jitter ISN'T being
applied somewhere it should be. Open an issue with the soak
snapshot showing the spikes, the queue/handler involved, and a
sample of `(enqueued_at, attempt, next_retry_at)` triples.

---

## 5. What the scheduler events look like in a healthy storm

Tail the api logs and filter for the retry pipeline:

```bash
docker compose logs -f api | grep -E '"event":"queue\.retry'
```

Healthy steady-state, one row per scheduler tick that finds work:

```
{"event":"queue.retry.promoted","jobId":"01...","queue":"default","handler":"...","attempt":2,"lagMs":3142}
```

`lagMs` should be < the scheduler interval (5000ms default). If it's
consistently > 30000 (30s), the scheduler is starved — see §3.

Nack-side events appear at failure time:

```
{"event":"queue.retry.scheduled","jobId":"01...","queue":"default","handler":"...","attempt":1,"maxAttempts":3,"nextRetryAt":"...","delaySeconds":42.13,"errorClass":"..."}
```

The pair (`scheduled`, `promoted`) is correlated by `jobId`. The
operator timeline of a single retried job is:

```
queue.dequeue.claimed       (worker picks up)
queue.nack.recorded         (handler returns error)
queue.retry.scheduled       (Nack commits next_retry_at)
queue.retry.promoted        (scheduler flips failed → queued)
queue.dequeue.claimed       (next attempt starts; same jobId, attempt+1)
queue.ack.success           (eventually)
```

---

## Related

- `SPEC.md §3.5` — the retry scheduling contract
- `docs/decisions/0006_retry-scheduler-in-api-process.md` — why the
  scheduler lives in the api process
- `scripts/soak/sql/snapshot.sql` — `oldest_failed_due_lag_seconds`
  + `retry_due_now` are the canaries
