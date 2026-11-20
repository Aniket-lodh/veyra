-- 000007_create_queue_states_table.up.sql

CREATE TABLE queue_states (
    queue_name    TEXT PRIMARY KEY,
    paused        BOOLEAN NOT NULL DEFAULT false,
    paused_at     TIMESTAMPTZ,
    paused_reason TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER queue_states_ui_notify_ins
    AFTER INSERT ON queue_states
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('stats');

CREATE TRIGGER queue_states_ui_notify_upd
    AFTER UPDATE OF paused, paused_at, paused_reason
    ON queue_states
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('stats');

CREATE TRIGGER queue_states_ui_notify_del
    AFTER DELETE ON queue_states
    FOR EACH STATEMENT
    EXECUTE FUNCTION veyra_ui_notify('stats');
