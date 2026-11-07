-- Queue snapshot for operators.
--   docker compose exec postgres psql -U veyra veyra -f /dev/stdin < scripts/sql/queue_state.sql

\timing on
\pset null '(null)'

-- Jobs by status
SELECT status, COUNT(*) AS n
FROM jobs
GROUP BY status
ORDER BY n DESC;

-- In-flight leases
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

-- Leases expiring within 30s (reclaim candidates)
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

-- Recent dead-letters
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

-- Failures by handler and error class
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
