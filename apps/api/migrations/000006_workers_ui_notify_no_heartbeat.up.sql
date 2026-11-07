-- 000006_workers_ui_notify_no_heartbeat.up.sql
-- Heartbeats every few seconds were spamming the operator SSE bus.
-- Refresh the workers roster on structural changes only (ADR-0009).

DROP TRIGGER IF EXISTS workers_ui_notify_upd ON workers;

CREATE TRIGGER workers_ui_notify_upd
    AFTER UPDATE OF
        state,
        hostname,
        pid,
        version,
        started_at,
        heartbeat_interval_seconds,
        queues,
        handlers,
        max_concurrency,
        total_processed
    ON workers
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('workers');
