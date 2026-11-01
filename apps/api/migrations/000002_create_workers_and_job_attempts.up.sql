-- 000002_create_workers_and_job_attempts.up.sql
--
-- The two coordination tables that complete the MVP schema alongside `jobs`:
--
--   workers       — the roster of processes that can execute jobs.
--                   Observational, not authoritative; the dequeue path does
--                   not depend on it for lease correctness.
--   job_attempts  — append-only per-attempt history. One row per
--                   (job_id, attempt_number), updated exactly once when
--                   the attempt ends.
--
-- See docs/architecture/database-schema.md for the WHY behind every column,
-- constraint, and index. The doc is the reasoning; this file is the DDL.
--
-- Deliberately not present:
--   * Foreign key from jobs.current_worker_id → workers(id).
--     The relationship is behavioral (heartbeats, leases), not referential.
--     A worker must be deletable without cascading havoc on historical jobs.
--   * Foreign key from job_attempts.worker_id → workers(id).
--     Same reasoning: the attempt history must survive a worker's deletion.

-- ---------------------------------------------------------------------------
-- Enum: worker_state
--
-- Four values matching the frozen frontend WorkerState contract.
-- ---------------------------------------------------------------------------
CREATE TYPE worker_state AS ENUM (
    'active',
    'idle',
    'draining',
    'disconnected'
);

-- ---------------------------------------------------------------------------
-- Enum: attempt_outcome
--
-- Five values. Note: 'lease_lost' here uses an underscore; the API
-- serializer renames it to 'lease-lost' for the frontend, the same pattern
-- used for 'dead_lettered' → 'dead-lettered' on jobs.status.
--
-- The 'lease_lost' outcome is distinct from 'failed' because the meaning
-- differs: 'failed' means the handler reported failure; 'lease_lost' means
-- the worker stopped heartbeating and another worker reclaimed the job.
-- Operator dashboards care about that difference.
-- ---------------------------------------------------------------------------
CREATE TYPE attempt_outcome AS ENUM (
    'succeeded',
    'failed',
    'timeout',
    'cancelled',
    'lease_lost'
);

-- ---------------------------------------------------------------------------
-- Table: workers
--
-- Registration is INSERT on startup; heartbeat is UPDATE of last_heartbeat_at;
-- graceful shutdown sets state='disconnected' (or 'draining' first, then
-- 'disconnected' after the worker quiesces). A sweeper marks workers
-- 'disconnected' when (now() - last_heartbeat_at) > heartbeat_interval * 3.
-- ---------------------------------------------------------------------------
CREATE TABLE workers (
    -- Identity — the runtime id.
    --
    -- EPHEMERAL per process boot. Every worker process generates a fresh
    -- id at startup (typically a ULID); two boots of the "same" logical
    -- worker produce different ids. This is deliberate and load-bearing:
    --
    --   * The lease guard pattern on jobs is
    --       WHERE current_worker_id = $me AND status = 'running'
    --     If ids were stable across restarts, a freshly-booted process
    --     would inherit ownership of leases held by the previous
    --     (crashed) runtime. A Heartbeat from the new runtime would
    --     silently extend the dead runtime's lease, Ack could mark a
    --     job done that the new runtime never executed, and the
    --     dequeue's reclaim predicate (lease_expires_at < now()) would
    --     never fire. Ephemeral ids make crash-recovery correct without
    --     any extra fencing.
    --
    --   * The stable, operator-facing identity of a worker is carried
    --     by `hostname` (and `version`, if the operator wants to track
    --     deploys). The UI groups runtimes by hostname to follow a box
    --     across restarts; a crashed runtime leaves its old row behind
    --     until the sweeper marks it 'disconnected', and the new boot
    --     inserts a NEW row.
    id TEXT PRIMARY KEY,

    -- Descriptive — for the operator UI, not for routing or correctness.
    hostname TEXT NOT NULL,
    pid      INT  NOT NULL,
    version  TEXT NOT NULL,

    -- Liveness state.
    state worker_state NOT NULL DEFAULT 'active',

    -- Clock fields. All TIMESTAMPTZ written by the DB; workers never pass
    -- their local clock in. The interval is the worker's contract:
    -- "I will heartbeat at most every N seconds."
    started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_interval_seconds INT         NOT NULL DEFAULT 5,

    -- Capability advertisement — for OBSERVABILITY only.
    --
    -- The operator UI reads these to answer "what is this runtime capable
    -- of right now" and "which runtimes can pick up handler X". The
    -- dequeue path does NOT read these columns. Workers pass their
    -- capability set as parameters on every Dequeue call; the SQL filters
    -- with:
    --     WHERE queue = ANY($queues) AND handler = ANY($handlers)
    -- never via a JOIN against `workers`. Coupling the dequeue hot path
    -- to this table's locks and indexes would defeat Postgres-as-a-queue.
    queues   TEXT[] NOT NULL,
    handlers TEXT[] NOT NULL,

    -- Concurrency advertisement. Advisory — the worker enforces it; we
    -- store it so operators can reason about expected capacity.
    max_concurrency INT NOT NULL,

    -- Lifetime job count. Worker-maintained, NOT authoritative (a crash
    -- can lose the most recent increments). Useful as an operator metric,
    -- not as a billing source.
    total_processed BIGINT NOT NULL DEFAULT 0,

    -- ---- Invariants ----
    CONSTRAINT workers_max_concurrency_positive
        CHECK (max_concurrency >= 1),
    CONSTRAINT workers_heartbeat_interval_positive
        CHECK (heartbeat_interval_seconds >= 1),
    CONSTRAINT workers_total_processed_nonneg
        CHECK (total_processed >= 0)
);

-- Sweeper hot path: scan workers whose state is still considered live,
-- ordered by how stale their last heartbeat is. The partial WHERE keeps
-- this small — once a worker is 'disconnected' or 'draining' the sweeper
-- has nothing to do with it.
CREATE INDEX idx_workers_live_heartbeat
    ON workers (last_heartbeat_at)
    WHERE state IN ('active', 'idle');

-- ---------------------------------------------------------------------------
-- Table: job_attempts
--
-- Append-only audit log. Two writes per attempt:
--   1. INSERT on dequeue (started_at = now(); ended_at, outcome NULL).
--   2. UPDATE when the attempt ends (sets ended_at and outcome).
-- Lease-loss is special: dequeue's reclaim path UPDATEs the prior row
-- (outcome='lease_lost', ended_at = prior lease_expires_at) and inserts
-- a new row in the same transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE job_attempts (
    -- Internal id. BIGSERIAL because monotonic insertion order is useful
    -- and we never expose this externally (the (job_id, attempt_number)
    -- composite is the user-facing identifier).
    id BIGSERIAL PRIMARY KEY,

    -- Hard FK with cascade: if a job is purged, its history goes with it.
    -- This is the only FK in the coordination schema; it is deliberately
    -- the strong relationship, not the worker one.
    job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number INT  NOT NULL,

    -- Snapshot of the worker that ran this attempt. NOT a foreign key — see
    -- the file header. We accept losing the worker linkage in the operator
    -- UI when a worker is deleted; we do not accept cascading deletes
    -- through history.
    worker_id TEXT NOT NULL,

    -- Per-attempt timestamps. started_at is set on insert; ended_at is set
    -- when the attempt terminates (by Ack, Nack, Cancel, or reclaim).
    started_at TIMESTAMPTZ NOT NULL,
    ended_at   TIMESTAMPTZ,

    -- Outcome. NULL while the attempt is in-flight, set together with
    -- ended_at when the attempt finishes.
    outcome attempt_outcome,

    -- Flat copy of the most useful error fields for table display. The
    -- structured error (with stack trace) lives on jobs.error for the
    -- latest attempt; per-attempt errors are intentionally lossy.
    error_class   TEXT,
    error_message TEXT,

    -- ---- Invariants ----
    CONSTRAINT job_attempts_attempt_positive
        CHECK (attempt_number >= 1),
    -- An attempt cannot end before it began.
    CONSTRAINT job_attempts_end_after_start
        CHECK (ended_at IS NULL OR ended_at >= started_at),
    -- ended_at and outcome are set together: NULL iff NULL.
    CONSTRAINT job_attempts_outcome_matches_end
        CHECK ((outcome IS NULL) = (ended_at IS NULL))
);

-- Unique per (job, attempt). Drives the per-job history view and prevents
-- a double-insert from racing two writers.
CREATE UNIQUE INDEX idx_job_attempts_per_job
    ON job_attempts (job_id, attempt_number);

-- Per-worker history view: "what has this worker been doing recently".
CREATE INDEX idx_job_attempts_per_worker
    ON job_attempts (worker_id, started_at DESC);
