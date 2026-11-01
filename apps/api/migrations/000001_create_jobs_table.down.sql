-- 000001_create_jobs_table.down.sql
--
-- Reverses 000001_create_jobs_table.up.sql.
--
-- DROP TABLE cascades to indexes and CHECK constraints owned by the table,
-- so we do not enumerate them. The job_status enum is a separate object
-- and must be dropped explicitly after the table that references it is
-- gone.

DROP TABLE IF EXISTS jobs;
DROP TYPE  IF EXISTS job_status;
