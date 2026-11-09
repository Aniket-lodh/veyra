-- 000005_ui_live_notify.down.sql

DROP TRIGGER IF EXISTS jobs_ui_notify_ins ON jobs;
DROP TRIGGER IF EXISTS jobs_ui_notify_del ON jobs;
DROP TRIGGER IF EXISTS jobs_ui_notify_upd ON jobs;
DROP TRIGGER IF EXISTS workers_ui_notify_ins ON workers;
DROP TRIGGER IF EXISTS workers_ui_notify_del ON workers;
DROP TRIGGER IF EXISTS workers_ui_notify_upd ON workers;
DROP FUNCTION IF EXISTS veyra_ui_notify();
