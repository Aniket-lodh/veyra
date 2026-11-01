-- 000002_create_workers_and_job_attempts.down.sql
--
-- Reverses 000002. Order matters: drop tables before the enum types they
-- reference, since Postgres will refuse to drop an in-use type.
--
-- DROP TABLE cascades to indexes, CHECK constraints, and foreign keys
-- owned by the table, so we do not enumerate them.

DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS workers;
DROP TYPE  IF EXISTS attempt_outcome;
DROP TYPE  IF EXISTS worker_state;
