-- 000007_create_queue_states_table.down.sql

DROP TRIGGER IF EXISTS queue_states_ui_notify_del ON queue_states;
DROP TRIGGER IF EXISTS queue_states_ui_notify_upd ON queue_states;
DROP TRIGGER IF EXISTS queue_states_ui_notify_ins ON queue_states;
DROP TABLE IF EXISTS queue_states;
