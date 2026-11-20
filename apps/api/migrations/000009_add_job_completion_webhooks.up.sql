ALTER TABLE jobs
    ADD COLUMN callback_url TEXT,
    ADD COLUMN callback_status TEXT CHECK (callback_status IN ('pending', 'running', 'delivered', 'failed')),
    ADD COLUMN callback_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN callback_last_error TEXT,
    ADD COLUMN callback_delivered_at TIMESTAMPTZ,
    ADD COLUMN callback_next_retry_at TIMESTAMPTZ;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_callback_consistency CHECK (
        (callback_url IS NULL AND callback_status IS NULL) OR
        (callback_url IS NOT NULL AND callback_status IS NOT NULL)
    );

CREATE INDEX idx_jobs_callback_pending
ON jobs (callback_next_retry_at ASC NULLS FIRST, id ASC)
WHERE callback_url IS NOT NULL
  AND callback_status IN ('pending', 'running');
