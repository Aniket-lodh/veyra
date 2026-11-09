-- 000002_create_workers_and_job_attempts.down.sql

DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS workers;
DROP TYPE  IF EXISTS attempt_outcome;
DROP TYPE  IF EXISTS worker_state;
