// Package queuecore is the queue. Job model, lifecycle primitives, and the
// SQL that backs them all live here; apps/api and apps/worker both depend on
// this package and reason about jobs through the same code path.
//
// The semantics are pinned in SPEC.md in this directory; any change to the
// observable behavior of Enqueue, Dequeue, Ack, Nack, Heartbeat, or Cancel
// must update the spec first. See docs/decisions/0004 for the rule.
package queuecore

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// JobStatus is the storage-level enum. Six values, matching `job_status` in
// the database. The seventh value the API surfaces ("scheduled") is derived
// at serialization time; it is never stored.
type JobStatus string

const (
	StatusQueued       JobStatus = "queued"
	StatusRunning      JobStatus = "running"
	StatusSucceeded    JobStatus = "succeeded"
	StatusFailed       JobStatus = "failed"
	StatusDeadLettered JobStatus = "dead_lettered"
	StatusCancelled    JobStatus = "cancelled"
)

// BackoffStrategy is the retry policy. Stored as a JSONB blob; interpreted by
// the (future) retries package. Shape matches the frozen frontend contract
// (camelCase fields). The discriminant is `Kind`; the relevant secondary
// fields are populated by kind.
type BackoffStrategy struct {
	Kind        string `json:"kind"`
	BaseSeconds *int   `json:"baseSeconds,omitempty"`
	CapSeconds  *int   `json:"capSeconds,omitempty"`
	Seconds     *int   `json:"seconds,omitempty"`
}

// Validate enforces the discriminated-union invariants the schema's JSONB
// column does not. Called on every enqueue.
func (b BackoffStrategy) Validate() error {
	switch b.Kind {
	case "exponential":
		if b.BaseSeconds == nil || b.CapSeconds == nil {
			return errors.New("backoff: exponential requires baseSeconds and capSeconds")
		}
		if *b.BaseSeconds <= 0 || *b.CapSeconds <= 0 {
			return errors.New("backoff: baseSeconds and capSeconds must be positive")
		}
		if *b.CapSeconds < *b.BaseSeconds {
			return errors.New("backoff: capSeconds must be >= baseSeconds")
		}
	case "fixed":
		if b.Seconds == nil {
			return errors.New("backoff: fixed requires seconds")
		}
		if *b.Seconds <= 0 {
			return errors.New("backoff: seconds must be positive")
		}
	case "":
		return errors.New("backoff: kind is required")
	default:
		return fmt.Errorf("backoff: unknown kind %q", b.Kind)
	}
	return nil
}

// DefaultBackoff is applied when the caller does not specify one on enqueue.
// Exponential, 30s base, 1h cap — reasonable for the bulk of background work.
// The handler clones this so per-job mutations cannot leak.
func DefaultBackoff() BackoffStrategy {
	base := 30
	cap := 3600
	return BackoffStrategy{
		Kind:        "exponential",
		BaseSeconds: &base,
		CapSeconds:  &cap,
	}
}

// JobError is the structured error stored on a job after a failed attempt.
// Shape matches the frozen frontend contract.
type JobError struct {
	Class      string    `json:"class"`
	Message    string    `json:"message"`
	StackTrace string    `json:"stackTrace"`
	OccurredAt time.Time `json:"occurredAt"`
}

// Job is the in-memory representation of one row in the `jobs` table.
//
// Fields with `*` are nullable in the database. JSONB payloads (payload,
// result) are kept as raw bytes — the queue does not interpret them. The
// structured `error` and `backoff` JSONB columns are decoded into typed
// values because the queue layer does interpret them.
type Job struct {
	ID             string
	Handler        string
	Queue          string
	Priority       int
	IdempotencyKey *string

	Payload json.RawMessage
	Result  json.RawMessage
	Error   *JobError

	Attempt     int
	MaxAttempts int
	Backoff     BackoffStrategy

	EnqueuedAt     time.Time
	ScheduledFor   time.Time
	StartedAt      *time.Time
	CompletedAt    *time.Time
	CancelledAt    *time.Time
	DeadLetteredAt *time.Time

	CurrentWorkerID *string
	LeaseExpiresAt  *time.Time
	NextRetryAt     *time.Time

	Status JobStatus
}

// Attempt is one row of the `job_attempts` table — a single execution of a
// job, in-flight or terminal. Shape mirrors the frozen frontend `JobAttempt`
// contract. The (JobID, AttemptNumber) pair is the user-facing identifier;
// the bigserial primary key is not exposed.
//
// EndedAt and Outcome are nil while the attempt is in flight; CHECK
// constraint job_attempts_outcome_matches_end guarantees they flip together.
type Attempt struct {
	JobID         string
	AttemptNumber int
	WorkerID      string
	StartedAt     time.Time
	EndedAt       *time.Time
	Outcome       *AttemptOutcome
	ErrorClass    *string
	ErrorMessage  *string
}

// AttemptOutcome is the storage-level enum from `attempt_outcome`. Five
// values; the API renames LeaseLost ("lease_lost") to "lease-lost" before
// serializing, mirroring the dead_lettered → dead-lettered convention on
// JobStatus.
type AttemptOutcome string

const (
	OutcomeSucceeded AttemptOutcome = "succeeded"
	OutcomeFailed    AttemptOutcome = "failed"
	OutcomeTimeout   AttemptOutcome = "timeout"
	OutcomeCancelled AttemptOutcome = "cancelled"
	OutcomeLeaseLost AttemptOutcome = "lease_lost"
)

// QueueStats is the aggregated counts surface that powers the operator
// dashboard. Totals are global (across all queues); PerQueue is one entry
// per known queue. "Known" = a queue that has at least one row in `jobs`.
//
// Fields that require a time-series store (jobs/min, p50, p95) are not
// populated here — they are computed by a future metrics layer and
// surfaced separately.
type QueueStats struct {
	Totals   StatusCounts
	PerQueue []QueueAggregate
}

// StatusCounts is the count of jobs in each storage status, plus the
// API-derived Scheduled bucket (queued AND scheduled_for > now()). Note
// that Queued in this struct means "queued AND due" — the visible-now
// subset of status='queued'; the future-scheduled ones live in Scheduled.
// This split matches the 7-value frontend status vocabulary.
type StatusCounts struct {
	Queued       int
	Scheduled    int
	Running      int
	Succeeded    int
	Failed       int
	DeadLettered int
	Cancelled    int
}

// QueueAggregate is one queue's view. Depth is the visible-and-runnable
// count (queued + due); InFlight is currently-running. The 24h windows
// look back exactly 24 hours from now(), bucketed by the terminal
// transition time (completed_at / dead_lettered_at).
type QueueAggregate struct {
	Name            string
	Depth           int
	InFlight        int
	Succeeded24h    int
	Failed24h       int
	DeadLettered24h int
}

// RunningLease is a thin row used by the workers handler to materialize
// `worker.leases[]` for the operator UI. It is the only shape that crosses
// the queue-core ↔ workers boundary — workers asks queue-core for "what
// jobs are currently running, owned by which worker" and zips the result
// onto the workers table.
type RunningLease struct {
	JobID          string
	Handler        string
	Queue          string
	Attempt        int
	WorkerID       string
	StartedAt      *time.Time
	LeaseExpiresAt *time.Time
}
