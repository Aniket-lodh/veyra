DROP INDEX IF EXISTS idx_jobs_callback_pending;

ALTER TABLE jobs
    DROP CONSTRAINT IF EXISTS jobs_callback_consistency,
    DROP COLUMN IF EXISTS callback_next_retry_at,
    DROP COLUMN IF EXISTS callback_delivered_at,
    DROP COLUMN IF EXISTS callback_last_error,
    DROP COLUMN IF EXISTS callback_attempts,
    DROP COLUMN IF EXISTS callback_status,
    DROP COLUMN IF EXISTS callback_url;
