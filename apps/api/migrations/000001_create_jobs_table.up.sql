-- 000001_create_jobs_table.up.sql

CREATE TYPE job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'dead_lettered',
    'cancelled'
);

CREATE TABLE jobs (
    id              TEXT        PRIMARY KEY,
    handler         TEXT        NOT NULL,
    queue           TEXT        NOT NULL,
    priority        SMALLINT    NOT NULL DEFAULT 5,
    idempotency_key TEXT,

    payload JSONB NOT NULL,
    result  JSONB,
    error   JSONB,

    attempt      INT   NOT NULL DEFAULT 0,
    max_attempts INT   NOT NULL DEFAULT 3,
    backoff      JSONB NOT NULL,

    enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_for    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    cancelled_at     TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ,

    current_worker_id TEXT,
    lease_expires_at  TIMESTAMPTZ,
    next_retry_at     TIMESTAMPTZ,

    status job_status NOT NULL DEFAULT 'queued',

    CONSTRAINT jobs_priority_range
        CHECK (priority BETWEEN 0 AND 9),

    CONSTRAINT jobs_max_attempts_positive
        CHECK (max_attempts >= 1),

    CONSTRAINT jobs_attempt_bounds
        CHECK (attempt >= 0 AND attempt <= max_attempts),

    CONSTRAINT jobs_lease_consistency CHECK (
        (status = 'running'
            AND current_worker_id IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'running'
            AND current_worker_id IS NULL
            AND lease_expires_at IS NULL)
    ),

    CONSTRAINT jobs_retry_consistency CHECK (
        next_retry_at IS NULL OR status = 'failed'
    ),

    CONSTRAINT jobs_terminal_exclusivity CHECK (
        (
            (completed_at     IS NOT NULL)::int +
            (cancelled_at     IS NOT NULL)::int +
            (dead_lettered_at IS NOT NULL)::int
        ) <= 1
        AND (status = 'succeeded')     = (completed_at     IS NOT NULL)
        AND (status = 'cancelled')     = (cancelled_at     IS NOT NULL)
        AND (status = 'dead_lettered') = (dead_lettered_at IS NOT NULL)
    )
);

CREATE INDEX idx_jobs_runnable
    ON jobs (queue, handler, priority DESC, scheduled_for ASC)
    WHERE status = 'queued';

CREATE INDEX idx_jobs_retry_pending
    ON jobs (queue, handler, priority DESC, next_retry_at ASC)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;

CREATE INDEX idx_jobs_lease_expired
    ON jobs (lease_expires_at)
    WHERE status = 'running';

CREATE INDEX idx_jobs_current_worker
    ON jobs (current_worker_id)
    WHERE status = 'running';

CREATE INDEX idx_jobs_recent_completed
    ON jobs (status, completed_at DESC);

CREATE UNIQUE INDEX idx_jobs_idempotency
    ON jobs (queue, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
