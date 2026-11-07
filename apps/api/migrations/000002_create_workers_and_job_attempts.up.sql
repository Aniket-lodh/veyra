-- 000002_create_workers_and_job_attempts.up.sql

CREATE TYPE worker_state AS ENUM (
    'active',
    'idle',
    'draining',
    'disconnected'
);

CREATE TYPE attempt_outcome AS ENUM (
    'succeeded',
    'failed',
    'timeout',
    'cancelled',
    'lease_lost'
);

CREATE TABLE workers (
    id TEXT PRIMARY KEY,

    hostname TEXT NOT NULL,
    pid      INT  NOT NULL,
    version  TEXT NOT NULL,

    state worker_state NOT NULL DEFAULT 'active',

    started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_interval_seconds INT         NOT NULL DEFAULT 5,

    queues   TEXT[] NOT NULL,
    handlers TEXT[] NOT NULL,

    max_concurrency INT NOT NULL,

    total_processed BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT workers_max_concurrency_positive
        CHECK (max_concurrency >= 1),
    CONSTRAINT workers_heartbeat_interval_positive
        CHECK (heartbeat_interval_seconds >= 1),
    CONSTRAINT workers_total_processed_nonneg
        CHECK (total_processed >= 0)
);

CREATE INDEX idx_workers_live_heartbeat
    ON workers (last_heartbeat_at)
    WHERE state IN ('active', 'idle');

CREATE TABLE job_attempts (
    id BIGSERIAL PRIMARY KEY,

    job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number INT  NOT NULL,

    worker_id TEXT NOT NULL,

    started_at TIMESTAMPTZ NOT NULL,
    ended_at   TIMESTAMPTZ,

    outcome attempt_outcome,

    error_class   TEXT,
    error_message TEXT,

    CONSTRAINT job_attempts_attempt_positive
        CHECK (attempt_number >= 1),
    CONSTRAINT job_attempts_end_after_start
        CHECK (ended_at IS NULL OR ended_at >= started_at),
    CONSTRAINT job_attempts_outcome_matches_end
        CHECK ((outcome IS NULL) = (ended_at IS NULL))
);

CREATE UNIQUE INDEX idx_job_attempts_per_job
    ON job_attempts (job_id, attempt_number);

CREATE INDEX idx_job_attempts_per_worker
    ON job_attempts (worker_id, started_at DESC);
