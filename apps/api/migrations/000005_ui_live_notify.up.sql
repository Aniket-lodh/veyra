-- 000005_ui_live_notify.up.sql
-- Operator UI change fan-out (ADR-0009). Workers still poll for dequeue.

CREATE OR REPLACE FUNCTION veyra_ui_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('veyra_ui', TG_ARGV[0]);
    RETURN NULL;
END;
$$;

-- jobs: skip lease-only renewals (lease_expires_at alone).
CREATE TRIGGER jobs_ui_notify_ins
    AFTER INSERT ON jobs
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('jobs');

CREATE TRIGGER jobs_ui_notify_del
    AFTER DELETE ON jobs
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('jobs');

CREATE TRIGGER jobs_ui_notify_upd
    AFTER UPDATE OF
        status,
        attempt,
        max_attempts,
        priority,
        scheduled_for,
        next_retry_at,
        payload,
        result,
        error,
        started_at,
        completed_at,
        cancelled_at,
        dead_lettered_at,
        current_worker_id,
        handler,
        queue
    ON jobs
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('jobs');

-- workers: roster + heartbeat (api hub throttles heartbeat storms).
CREATE TRIGGER workers_ui_notify_ins
    AFTER INSERT ON workers
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('workers');

CREATE TRIGGER workers_ui_notify_del
    AFTER DELETE ON workers
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('workers');

CREATE TRIGGER workers_ui_notify_upd
    AFTER UPDATE OF
        state,
        hostname,
        pid,
        version,
        started_at,
        last_heartbeat_at,
        heartbeat_interval_seconds,
        queues,
        handlers,
        max_concurrency,
        total_processed
    ON workers
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('workers');
