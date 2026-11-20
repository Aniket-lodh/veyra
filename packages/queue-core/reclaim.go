package queuecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// ReclaimGraceSeconds is the hardcoded grace window appended to lease_expires_at before a row is considered reclaimable.
const ReclaimGraceSeconds = 10

// ReclaimMode selects the continuation that the primitive runs after closing the prior attempt.
type ReclaimMode string

const (
	// InlineClaim: the caller is Dequeue, has already locked the candidate via §1.4, and intends to take over the row under a new worker.
	ReclaimModeInlineClaim ReclaimMode = "inline_claim"

	// TickRequeue: the caller is the api-side periodic reclaim driver.
	ReclaimModeTickRequeue ReclaimMode = "tick_requeue"
)

// ReclaimOutcome distinguishes the three terminal states the primitive can leave the row in.
type ReclaimOutcome string

const (
	// ReclaimOutcomeClaimed: InlineClaim path, budget remained, row now owned by ClaimingWorkerID.
	ReclaimOutcomeClaimed ReclaimOutcome = "claimed"

	// ReclaimOutcomeRequeued: TickRequeue path, budget remained, row transitioned to 'queued'.
	ReclaimOutcomeRequeued ReclaimOutcome = "requeued"

	// ReclaimOutcomeDeadLettered: either path, budget exhausted, row transitioned to 'dead_lettered' in place.
	ReclaimOutcomeDeadLettered ReclaimOutcome = "dead_lettered"

	// ReclaimOutcomeStale: §5.4's post-lock revalidation failed — the row changed state between the caller's SELECT and the primitive's…
	ReclaimOutcomeStale ReclaimOutcome = "stale"
)

// ReclaimParams is the input to Reclaim.
type ReclaimParams struct {
	Mode             ReclaimMode
	JobID            string
	Attempt          int
	MaxAttempts      int
	PriorWorkerID    string // may be empty when the prior row had current_worker_id IS NULL
	ClaimingWorkerID string // required for InlineClaim; unused for TickRequeue
}

// ReclaimResult is the primitive's per-row output.
type ReclaimResult struct {
	Outcome ReclaimOutcome
	Claimed *Job
}

// Reclaim is the queue-core reclaim primitive.
func Reclaim(ctx context.Context, tx pgx.Tx, p ReclaimParams) (*ReclaimResult, error) {
	if err := validateReclaimParams(p); err != nil {
		return nil, err
	}

	site := siteFromMode(p.Mode)

	// §5.4 — post-lock revalidation + close prior attempt (always; both branches).
	const closeWithRecheckSQL = `
		UPDATE job_attempts ja
		SET outcome  = 'lease_lost',
		    ended_at = now()
		FROM jobs j
		WHERE ja.job_id         = $1
		  AND ja.attempt_number = $2
		  AND ja.ended_at IS NULL
		  AND j.id              = $1
		  AND j.status          = 'running'
		  AND j.attempt         = $2
		  AND j.lease_expires_at + make_interval(secs => $3) <= now()
	`
	cmd, err := tx.Exec(ctx, closeWithRecheckSQL, p.JobID, p.Attempt, ReclaimGraceSeconds)
	if err != nil {
		slog.ErrorContext(ctx, "queue.reclaim.row.failed",
			"site", site,
			"jobId", p.JobID,
			"err", err.Error(),
		)
		return nil, fmt.Errorf("queuecore.Reclaim: close prior attempt: %w", err)
	}
	if cmd.RowsAffected() == 0 {
		slog.WarnContext(ctx, "queue.reclaim.row.stale",
			"site", site,
			"jobId", p.JobID,
			"expectedAttempt", p.Attempt,
			"reason", "recheck_failed",
		)
		return &ReclaimResult{Outcome: ReclaimOutcomeStale}, nil
	}
	slog.InfoContext(ctx, "queue.reclaim.row.closed_prior",
		"site", site,
		"jobId", p.JobID,
		"priorAttemptNumber", p.Attempt,
		"priorWorkerId", p.PriorWorkerID,
		"rowsAffected", cmd.RowsAffected(),
	)

	// §5.6 — budget-exhausted branch.
	if p.Attempt >= p.MaxAttempts {
		dlqErr := JobError{
			Class:      "AttemptBudgetExhausted",
			Message:    fmt.Sprintf("lease expired during attempt %d of %d; no retry budget remains, dead-lettered on reclaim", p.Attempt, p.MaxAttempts),
			OccurredAt: time.Now(),
		}
		errJSON, marshalErr := json.Marshal(dlqErr)
		if marshalErr != nil {
			return nil, fmt.Errorf("queuecore.Reclaim: marshal dlq error: %w", marshalErr)
		}
		const dlqSQL = `
			UPDATE jobs
			SET status            = 'dead_lettered',
			    dead_lettered_at  = now(),
			    error             = $1,
			    current_worker_id = NULL,
			    lease_expires_at  = NULL
			WHERE id = $2
		`
		if _, err := tx.Exec(ctx, dlqSQL, errJSON, p.JobID); err != nil {
			return nil, fmt.Errorf("queuecore.Reclaim: dlq update: %w", err)
		}
		slog.InfoContext(ctx, "queue.reclaim.row.dlq",
			"site", site,
			"jobId", p.JobID,
			"attempt", p.Attempt,
			"maxAttempts", p.MaxAttempts,
			"priorWorkerId", p.PriorWorkerID,
		)
		return &ReclaimResult{Outcome: ReclaimOutcomeDeadLettered}, nil
	}

	// §5.5 — budget-remaining branch. Continuation depends on mode.
	switch p.Mode {
	case ReclaimModeInlineClaim:
		return reclaimInlineClaim(ctx, tx, p)
	case ReclaimModeTickRequeue:
		return reclaimTickRequeue(ctx, tx, p)
	default:
		// validateReclaimParams above rejects unknown modes; this is reachable only if a new mode is added without an arm here.
		return nil, fmt.Errorf("queuecore.Reclaim: unhandled mode %q", p.Mode)
	}
}

// reclaimInlineClaim runs §5.5.1: claim the row under ClaimingWorkerID, insert the new attempt, return the post-claim *Job.
func reclaimInlineClaim(ctx context.Context, tx pgx.Tx, p ReclaimParams) (*ReclaimResult, error) {
	const claimUpdateSQL = `
		UPDATE jobs
		SET status            = 'running',
		    current_worker_id = $1,
		    lease_expires_at  = now() + INTERVAL '30 seconds',
		    attempt           = attempt + 1,
		    started_at        = COALESCE(started_at, now())
		WHERE id = $2
		RETURNING ` + jobColumns
	claimed, err := scanJob(tx.QueryRow(ctx, claimUpdateSQL, p.ClaimingWorkerID, p.JobID))
	if err != nil {
		return nil, fmt.Errorf("queuecore.Reclaim: claim update: %w", err)
	}

	const insertAttemptSQL = `
		INSERT INTO job_attempts (job_id, attempt_number, worker_id, started_at)
		VALUES ($1, $2, $3, now())
	`
	if _, err := tx.Exec(ctx, insertAttemptSQL, claimed.ID, claimed.Attempt, p.ClaimingWorkerID); err != nil {
		return nil, fmt.Errorf("queuecore.Reclaim: insert attempt: %w", err)
	}

	leaseExpires := "(unset)"
	if claimed.LeaseExpiresAt != nil {
		leaseExpires = claimed.LeaseExpiresAt.Format(time.RFC3339Nano)
	}
	slog.InfoContext(ctx, "queue.reclaim.row.claimed",
		"site", "inline",
		"jobId", claimed.ID,
		"attempt", claimed.Attempt,
		"leaseExpiresAt", leaseExpires,
		"priorWorkerId", p.PriorWorkerID,
	)
	return &ReclaimResult{Outcome: ReclaimOutcomeClaimed, Claimed: claimed}, nil
}

// reclaimTickRequeue runs §5.5.2: requeue the row, preserving original scheduling coordinates.
func reclaimTickRequeue(ctx context.Context, tx pgx.Tx, p ReclaimParams) (*ReclaimResult, error) {
	// IMPORTANT: do NOT include scheduled_for or priority in the SET list.
	const requeueSQL = `
		UPDATE jobs
		SET status            = 'queued',
		    current_worker_id = NULL,
		    lease_expires_at  = NULL
		WHERE id = $1
	`
	if _, err := tx.Exec(ctx, requeueSQL, p.JobID); err != nil {
		return nil, fmt.Errorf("queuecore.Reclaim: requeue update: %w", err)
	}
	slog.InfoContext(ctx, "queue.reclaim.row.requeued",
		"site", "tick",
		"jobId", p.JobID,
		"attempt", p.Attempt,
		"priorWorkerId", p.PriorWorkerID,
	)
	return &ReclaimResult{Outcome: ReclaimOutcomeRequeued}, nil
}

func siteFromMode(m ReclaimMode) string {
	switch m {
	case ReclaimModeInlineClaim:
		return "inline"
	case ReclaimModeTickRequeue:
		return "tick"
	default:
		return string(m)
	}
}

func validateReclaimParams(p ReclaimParams) error {
	if p.JobID == "" {
		return errors.New("queuecore.Reclaim: JobID is required")
	}
	if p.Attempt <= 0 {
		return fmt.Errorf("queuecore.Reclaim: Attempt must be > 0, got %d", p.Attempt)
	}
	if p.MaxAttempts <= 0 {
		return fmt.Errorf("queuecore.Reclaim: MaxAttempts must be > 0, got %d", p.MaxAttempts)
	}
	switch p.Mode {
	case ReclaimModeInlineClaim:
		if p.ClaimingWorkerID == "" {
			return errors.New("queuecore.Reclaim: ClaimingWorkerID is required for InlineClaim")
		}
		if p.ClaimingWorkerID == p.PriorWorkerID {
			return errors.New("queuecore.Reclaim: ClaimingWorkerID must differ from PriorWorkerID")
		}
	case ReclaimModeTickRequeue:
		// no additional requirements
	default:
		return fmt.Errorf("queuecore.Reclaim: unknown mode %q", p.Mode)
	}
	return nil
}
