-- Worker roster and heartbeat freshness (stale = > 3× heartbeat interval).

\timing on

SELECT
    id              AS worker_id,
    hostname,
    state,
    version,
    started_at,
    last_heartbeat_at,
    (now() - last_heartbeat_at) AS since_heartbeat,
    CASE
        WHEN now() - last_heartbeat_at
             > make_interval(secs => heartbeat_interval_seconds * 3)
        THEN 'STALE'
        ELSE 'ok'
    END             AS heartbeat_status,
    queues,
    handlers,
    max_concurrency,
    total_processed
FROM workers
ORDER BY last_heartbeat_at DESC;
