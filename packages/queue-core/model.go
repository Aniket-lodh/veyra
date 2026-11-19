// Package queuecore is the queue: model, primitives, and Postgres repository.
package queuecore

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// JobStatus is the storage-level enum.
type JobStatus string

const (
	StatusQueued       JobStatus = "queued"
	StatusRunning      JobStatus = "running"
	StatusSucceeded    JobStatus = "succeeded"
	StatusFailed       JobStatus = "failed"
	StatusDeadLettered JobStatus = "dead_lettered"
	StatusCancelled    JobStatus = "cancelled"
)

// BackoffStrategy is the retry policy.
type BackoffStrategy struct {
	Kind        string `json:"kind"`
	BaseSeconds *int   `json:"baseSeconds,omitempty"`
	CapSeconds  *int   `json:"capSeconds,omitempty"`
	Seconds     *int   `json:"seconds,omitempty"`
}

// Validate enforces the discriminated-union invariants the schema's JSONB column does not.
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
type JobError struct {
	Class      string    `json:"class"`
	Message    string    `json:"message"`
	StackTrace string    `json:"stackTrace"`
	OccurredAt time.Time `json:"occurredAt"`
}

// Job is the in-memory representation of one row in the `jobs` table.
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

// Attempt is one row of the `job_attempts` table — a single execution of a job, in-flight or terminal.
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

// AttemptOutcome is the storage-level enum from `attempt_outcome`.
type AttemptOutcome string

const (
	OutcomeSucceeded AttemptOutcome = "succeeded"
	OutcomeFailed    AttemptOutcome = "failed"
	OutcomeTimeout   AttemptOutcome = "timeout"
	OutcomeCancelled AttemptOutcome = "cancelled"
	OutcomeLeaseLost AttemptOutcome = "lease_lost"
)

// QueueStats is the aggregated counts surface that powers the operator dashboard.
type QueueStats struct {
	Totals   StatusCounts
	PerQueue []QueueAggregate
}

// StatusCounts is the count of jobs in each storage status, plus the API-derived Scheduled bucket (queued AND scheduled_for > now()).
type StatusCounts struct {
	Queued       int
	Scheduled    int
	Running      int
	Succeeded    int
	Failed       int
	DeadLettered int
	Cancelled    int
}

// QueueAggregate is one queue's view.
type QueueAggregate struct {
	Name            string
	Depth           int
	InFlight        int
	Succeeded24h    int
	Failed24h       int
	DeadLettered24h int
}

// RunningLease is a thin row used by the workers handler to materialize `worker.leases[]` for the operator UI.
type RunningLease struct {
	JobID          string
	Handler        string
	Queue          string
	Attempt        int
	WorkerID       string
	StartedAt      *time.Time
	LeaseExpiresAt *time.Time
}
