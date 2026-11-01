-- snapshot.sql — one row per snapshot tick. The soak harness calls this
-- and pipes the output into a logfile so the 24h run produces a time
-- series you can grep and chart.
--
-- Output is intentionally one line per metric prefixed with a tag, so
-- `grep ^queue_depth: snapshot.log | awk` extracts a series without
-- needing a CSV parser. Cheap, robust, scrollable.
--
-- A note on zero-counts (A3 from SOAK_REPORT.md run 20260526T122313Z):
-- the per-group emitters below (worker_count:STATE, jobs_total:STATUS,
-- queue_depth:QUEUE) all LEFT JOIN against a fixed key set so every
-- known state/status emits a line every tick — including zero. The
-- naive `GROUP BY state` form silently drops zero-count rows, which
-- causes any awk/grep that tracks the metric over time to "carry
-- forward" the previous value as if it were still current. That bug
-- made the 2026-05-26 timeline look like a worker survived for 5h
-- when it had already transitioned to 'disconnected'. Do NOT regress
-- this without auditing every downstream consumer.

\pset tuples_only on
\pset format unaligned

-- Workers by state — one line per known worker_state enum value.
-- enum_range(NULL::worker_state) returns every value the schema knows
-- about, so adding a new state via migration auto-extends the
-- snapshot without a script change.
SELECT 'worker_count:' || s.state::text || '=' || COALESCE(c.cnt, 0)
FROM unnest(enum_range(NULL::worker_state)) AS s(state)
LEFT JOIN (
    SELECT state, count(*) AS cnt FROM workers GROUP BY state
) c ON c.state = s.state
ORDER BY s.state;

-- Total + live workers (handy single-line aggregate).
SELECT 'worker_total=' || count(*) FROM workers;
SELECT 'worker_live=' || count(*) FROM workers WHERE state IN ('active', 'idle');

-- Stalest live worker — proxy for "is the sweeper keeping up?"
-- NOTE: this is meaningless when worker_live=0 (min over an empty set
-- is NULL → COALESCE returns 0, indistinguishable from "fresh
-- heartbeats"). Dashboard and alerting MUST gate on worker_live > 0
-- before reading this. Tracked as B1 in SOAK_REPORT.md.
SELECT 'worker_stalest_seconds=' ||
       COALESCE(EXTRACT(EPOCH FROM (now() - min(last_heartbeat_at)))::int, 0)
FROM workers WHERE state IN ('active', 'idle');

-- Per-runtime breadcrumbs — one line per row in the workers table.
-- This is the positive evidence stream for "a worker exists, who it
-- is, and when it last beat its heart". Used by post-soak tools to
-- prove resurrection happened: a hostname whose `id` changes across
-- ticks is a generation rotation. (B5 from SOAK_REPORT.md.)
SELECT 'worker_runtime:' || id
       || ' hostname=' || hostname
       || ' state=' || state::text
       || ' started_at=' || EXTRACT(EPOCH FROM started_at)::int
       || ' last_heartbeat_at=' || EXTRACT(EPOCH FROM last_heartbeat_at)::int
FROM workers
ORDER BY hostname, started_at;

-- Per-hostname generation count — how many distinct `workers.id` rows
-- have ever existed for each hostname. Each crash/restart cycle adds
-- one. Pair with the chaos log's `worker_recovery_seconds` to confirm
-- resurrection observability matches container-side reality.
SELECT 'worker_generation_count:' || hostname || '=' || count(*)
FROM workers
GROUP BY hostname
ORDER BY hostname;

-- Queue depths (visible + due) — one line per queue that has ever
-- existed in the jobs table. LEFT JOIN against DISTINCT queue, NOT
-- a GROUP BY over current `queued AND due` rows, so an emptying
-- queue still emits a `=0` line (instead of dropping out of the
-- snapshot stream and tricking downstream awk into carrying the
-- previous value). The set of queues is dynamic (any string a job
-- advertises), so we derive it from data rather than hardcoding.
SELECT 'queue_depth:' || q.queue || '=' || COALESCE(c.cnt, 0)
FROM (SELECT DISTINCT queue FROM jobs) q
LEFT JOIN (
    SELECT queue, count(*) AS cnt
    FROM jobs
    WHERE status = 'queued' AND scheduled_for <= now()
    GROUP BY queue
) c ON c.queue = q.queue
ORDER BY q.queue;

-- Currently-leased work — should equal worker_live × in_flight ceiling.
SELECT 'jobs_in_flight=' || count(*) FROM jobs WHERE status = 'running';

-- Lease health.
SELECT 'jobs_with_expired_lease=' || count(*)
FROM jobs
WHERE status = 'running' AND lease_expires_at < now();

-- Status totals (matches the dashboard) — one line per known job_status
-- enum value, including zero. Same anti-carry-forward reasoning as
-- worker_count above.
SELECT 'jobs_total:' || s.status::text || '=' || COALESCE(c.cnt, 0)
FROM unnest(enum_range(NULL::job_status)) AS s(status)
LEFT JOIN (
    SELECT status, count(*) AS cnt FROM jobs GROUP BY status
) c ON c.status = s.status
ORDER BY s.status;

-- Per-handler status breakdown (W4) — one line per (handler, status) for
-- every handler that has ever appeared in the jobs table, including the
-- zero combinations. Same anti-carry-forward discipline as jobs_total
-- above (the A3 lesson): a CROSS JOIN of DISTINCT handler × the job_status
-- enum, LEFT JOINed against live counts, so a status that drops to zero
-- for a handler still emits a `=0` line instead of vanishing from the
-- stream and tricking downstream awk into carrying the previous value.
-- This is how you answer "what is failing, for which workload" over time
-- (e.g. http_request:dead_lettered climbing while noop:dead_lettered=0).
SELECT 'jobs_by_handler:' || h.handler || ':' || s.status::text || '=' || COALESCE(c.cnt, 0)
FROM (SELECT DISTINCT handler FROM jobs) h
CROSS JOIN unnest(enum_range(NULL::job_status)) AS s(status)
LEFT JOIN (
    SELECT handler, status, count(*) AS cnt FROM jobs GROUP BY handler, status
) c ON c.handler = h.handler AND c.status = s.status
ORDER BY h.handler, s.status;

-- http_request failure breakdown by error class (W4) — the currently
-- failed (still retrying) + dead_lettered http_request jobs, grouped by
-- error class. LEFT JOINed against a FIXED set of the handler's known
-- classes so each emits every tick including zero (anti-carry-forward):
-- a class going quiet must read as `=0`, not drop out of the stream.
--
-- The class list mirrors apps/worker/internal/handler/http_request.go
-- (httpStatusClass + classifyTransportError + invalid_payload). The
-- 'unlisted' line below is the safety net: if the handler grows a class
-- and nobody updates this VALUES set, the new class lands in 'unlisted'
-- instead of being silently dropped by the join. Keep them in lockstep.
SELECT 'http_request_error:' || k.class || '=' || COALESCE(c.cnt, 0)
FROM (VALUES
    ('http_4xx'), ('http_5xx'), ('http_3xx'), ('http_other'),
    ('timeout'), ('dns'), ('connection_refused'), ('connection'),
    ('invalid_payload')
) AS k(class)
LEFT JOIN (
    SELECT error->>'class' AS class, count(*) AS cnt
    FROM jobs
    WHERE handler = 'http_request'
      AND status IN ('failed', 'dead_lettered')
      AND error IS NOT NULL
    GROUP BY error->>'class'
) c ON c.class = k.class
ORDER BY k.class;

-- Catch-all for any http_request error class not in the fixed set above.
-- Should be 0; a non-zero value means the handler emitted a class the
-- snapshot doesn't enumerate yet — go add it to the VALUES list.
SELECT 'http_request_error:unlisted=' || count(*)
FROM jobs
WHERE handler = 'http_request'
  AND status IN ('failed', 'dead_lettered')
  AND error IS NOT NULL
  AND COALESCE(error->>'class', '') NOT IN (
      'http_4xx', 'http_5xx', 'http_3xx', 'http_other',
      'timeout', 'dns', 'connection_refused', 'connection',
      'invalid_payload'
  );

-- DLQ growth canary — should not exceed ~handler_error_rate × throughput.
SELECT 'jobs_dlq_last_5m=' || count(*)
FROM jobs
WHERE status = 'dead_lettered'
  AND dead_lettered_at >= now() - INTERVAL '5 minutes';

-- Attempt counter health — if attempts is climbing far above jobs, you
-- are in a reclaim loop.
SELECT 'attempts_total=' || count(*) FROM job_attempts;
SELECT 'attempts_lease_lost=' || count(*) FROM job_attempts WHERE outcome = 'lease_lost';

-- Retry pipeline health.
--
-- failed_total          : depth of the retry buffer.
-- retry_due_now         : how many rows the scheduler will promote on
--                         its next tick (LIMIT-clamped per tick).
-- oldest_failed_due_lag : the canary — seconds the oldest retry-due row
--                         has been waiting. Should hover near the
--                         scheduler interval (a few seconds). If this
--                         climbs, the scheduler is starved or down. See
--                         SPEC.md §3.5.5.
SELECT 'failed_total=' || count(*) FROM jobs WHERE status = 'failed';
SELECT 'retry_due_now=' || count(*)
FROM jobs
WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now();
SELECT 'oldest_failed_due_lag_seconds=' ||
       COALESCE(EXTRACT(EPOCH FROM (now() - min(next_retry_at)))::int, 0)
FROM jobs
WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now();
