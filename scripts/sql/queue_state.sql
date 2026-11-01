-- Snapshot of the queue right now. Useful for "what is the system doing"
-- between stress runs.
--
-- Usage:
--   docker compose exec postgres psql -U veyra veyra -f /dev/stdin < scripts/sql/queue_state.sql
--
-- Sections:
--   1. jobs by status — health-at-a-glance
--   2. in-flight leases — who is doing what and for how long
--   3. lease deadlines coming up — what's about to be reclaim-eligible
--   4. recent dead-letters — the operator's first port of call

\timing on
\pset null '(null)'

-- 1. Jobs by status.
SELECT status, COUNT(*) AS n
FROM jobs
GROUP BY status
ORDER BY n DESC;

-- 2. In-flight leases (running jobs and who owns them).
SELECT
    j.id              AS job_id,
    j.queue,
    j.handler,
    j.attempt,
    j.max_attempts,
    j.current_worker_id,
    j.lease_expires_at,
    (j.lease_expires_at - now()) AS lease_remaining,
    j.started_at
FROM jobs j
WHERE j.status = 'running'
ORDER BY j.lease_expires_at ASC
LIMIT 50;

-- 3. Lease deadlines within the next 30s — reclaim candidates.
SELECT
    id,
    queue,
    handler,
    current_worker_id,
    lease_expires_at
FROM jobs
WHERE status = 'running'
  AND lease_expires_at <= now() + INTERVAL '30 seconds'
ORDER BY lease_expires_at ASC;

-- 4. Recent dead-letters.
SELECT
    id,
    queue,
    handler,
    attempt,
    max_attempts,
    dead_lettered_at,
    error->>'class'   AS error_class,
    error->>'message' AS error_message
FROM jobs
WHERE status = 'dead_lettered'
ORDER BY dead_lettered_at DESC
LIMIT 20;

-- 5. Failures by handler and error class — the "what is failing, and why"
--    aggregate. Covers both still-retrying (failed) and terminal
--    (dead_lettered) jobs, so a class spiking shows up before it exhausts
--    its retry budget, not only after. Ordered by volume so the loudest
--    failure is on top. This is the operator's one-look answer to
--    "which workload is unhealthy, and how".
SELECT
    handler,
    status,
    error->>'class'   AS error_class,
    COUNT(*)          AS n
FROM jobs
WHERE status IN ('failed', 'dead_lettered')
  AND error IS NOT NULL
GROUP BY handler, status, error->>'class'
ORDER BY n DESC, handler, error_class;
