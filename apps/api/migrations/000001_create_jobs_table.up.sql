-- 000001_create_jobs_table.up.sql
--
-- Initial coordination schema: the `jobs` table.
--
-- See docs/architecture/database-schema.md for the WHY behind every column,
-- constraint, and index here. This migration is the authoritative DDL; the
-- document is the reasoning. The two must move together.
--
-- `job_attempts` and `workers` are intentionally NOT in this migration; they
-- ship as 000002 / 000003 so each table can be rolled forward and back
-- independently during early development.

-- ---------------------------------------------------------------------------
-- Enum: job_status
--
-- Six DB-level values. The seventh status surfaced by the API (`scheduled`)
-- is derived at serialization time from (status='queued' AND scheduled_for >
-- now()); it is NOT stored. See "Status mapping: storage vs API" in the
-- schema doc.
-- ---------------------------------------------------------------------------
CREATE TYPE job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'dead_lettered',
    'cancelled'
);

-- ---------------------------------------------------------------------------
-- Table: jobs
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
    -- Identity
    id              TEXT        PRIMARY KEY,
    handler         TEXT        NOT NULL,
    queue           TEXT        NOT NULL,
    priority        SMALLINT    NOT NULL DEFAULT 5,
    idempotency_key TEXT,

    -- Body (opaque to the schema; interpreted by handlers)
    payload JSONB NOT NULL,
    result  JSONB,
    error   JSONB,

    -- Retry policy
    attempt      INT   NOT NULL DEFAULT 0,
    max_attempts INT   NOT NULL DEFAULT 3,
    backoff      JSONB NOT NULL,

    -- Timestamps (coordination clock; all written by the database)
    enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_for    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    cancelled_at     TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ,

    -- Live lease and retry coordinates
    current_worker_id TEXT,
    lease_expires_at  TIMESTAMPTZ,
    next_retry_at     TIMESTAMPTZ,

    -- Status
    status job_status NOT NULL DEFAULT 'queued',

    -- -----------------------------------------------------------------------
    -- Invariants
    --
    -- These CHECK constraints turn coordination bugs into write failures
    -- rather than silently-stuck jobs. They cost a few CPU cycles per
    -- mutation and are worth it.
    -- -----------------------------------------------------------------------

    CONSTRAINT jobs_priority_range
        CHECK (priority BETWEEN 0 AND 9),

    CONSTRAINT jobs_max_attempts_positive
        CHECK (max_attempts >= 1),

    CONSTRAINT jobs_attempt_bounds
        CHECK (attempt >= 0 AND attempt <= max_attempts),

    -- Lease consistency: a row is `running` iff the lease coordinates are set,
    -- and vice versa. Catches "ack forgot to clear the lease" or "dequeue
    -- forgot to set it" at write time.
    CONSTRAINT jobs_lease_consistency CHECK (
        (status = 'running'
            AND current_worker_id IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'running'
            AND current_worker_id IS NULL
            AND lease_expires_at IS NULL)
    ),

    -- Retry pointer is meaningful only for `failed` jobs awaiting retry.
    CONSTRAINT jobs_retry_consistency CHECK (
        next_retry_at IS NULL OR status = 'failed'
    ),

    -- Terminal exclusivity: at most one terminal timestamp is set, and the
    -- one that is set must match the terminal status. A non-terminal status
    -- has all three terminal timestamps NULL.
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

-- ---------------------------------------------------------------------------
-- Indexes
--
-- The dequeue query is the hot path. Partial indexes on the runnable subset
-- of rows are the canonical Postgres-as-queue technique: they exclude the
-- bulk of `succeeded`/`dead_lettered` rows that the dequeue WHERE clause
-- never matches.
--
-- A note for future migrations: CREATE INDEX CONCURRENTLY is required on
-- populated tables. This migration creates indexes on a brand-new (empty)
-- table, so plain CREATE INDEX is correct and cheap here. Do NOT copy this
-- pattern into a migration that runs against existing data.
-- ---------------------------------------------------------------------------

-- Hot path: new and visible work, ordered the same way as the dequeue query.
CREATE INDEX idx_jobs_runnable
    ON jobs (queue, handler, priority DESC, scheduled_for ASC)
    WHERE status = 'queued';

-- Hot path: failed work whose retry timer has elapsed.
CREATE INDEX idx_jobs_retry_pending
    ON jobs (queue, handler, priority DESC, next_retry_at ASC)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;

-- Hot path: in-flight jobs whose lease has expired (reclaim candidates).
-- Small index because `running` is a thin slice of the table at any moment.
CREATE INDEX idx_jobs_lease_expired
    ON jobs (lease_expires_at)
    WHERE status = 'running';

-- "What is this worker currently doing" — UI lookup, not on the dequeue path.
CREATE INDEX idx_jobs_current_worker
    ON jobs (current_worker_id)
    WHERE status = 'running';

-- Operator UI: "recently succeeded" list.
CREATE INDEX idx_jobs_recent_completed
    ON jobs (status, completed_at DESC);

-- Idempotency: a job with a key cannot collide with another job that has
-- the same key in the same queue. Partial so NULL keys (the common case)
-- do not consume index space.
CREATE UNIQUE INDEX idx_jobs_idempotency
    ON jobs (queue, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
