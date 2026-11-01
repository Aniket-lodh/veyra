// Package queuecore — reclaim primitive.
//
// Reclaim transitions a job whose lease has expired out of `running`
// state. It is the system's only mechanism for recovering ownership
// when a worker stops heartbeating — for any reason: crash, kernel
// kill, OOM, network partition, host pause, container restart.
//
// There is exactly ONE implementation of reclaim in the codebase.
// Multiple call sites invoke it via the modes defined below. Drift
// between two implementations of reclaim would silently miscount
// attempts, mis-trigger DLQ, and let lease ownership end up in
// inconsistent states. See packages/queue-core/SPEC.md §5 and the
// `feedback-shared-semantics-shared-primitive` memory.
//
// This file owns: §5.4 (close prior attempt), §5.5.1 (InlineClaim
// continuation), §5.5.2 (TickRequeue continuation), §5.6
// (budget-exhausted DLQ), and §5.12 (per-row observability). It does
// NOT own: §1.2 (selection predicate — callers issue their own SELECT),
// §5.9 (queue pause/drain — stub), §5.10 (tick driver — separate
// package), §5.13 (tests — alongside their callers).
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

// ReclaimGraceSeconds is the hardcoded grace window appended to
// lease_expires_at before a row is considered reclaimable. See SPEC §5.10.1
// for the rationale. TODO(reclaim-config): promote to a config field on
// Repository once the api wiring lands; the const-then-promote pattern
// matches `leaseDurationSeconds`'s trajectory.
const ReclaimGraceSeconds = 10

// ReclaimMode selects the continuation that the primitive runs after
// closing the prior attempt. See SPEC §5.5.
type ReclaimMode string

const (
	// InlineClaim: the caller is Dequeue, has already locked the candidate
	// via §1.4, and intends to take over the row under a new worker. The
	// primitive performs the claim UPDATE per §1.6 and INSERTs the new
	// attempt row per §1.7, then returns the *Job. Caller's responsibility
	// to commit the surrounding tx.
	ReclaimModeInlineClaim ReclaimMode = "inline_claim"

	// TickRequeue: the caller is the api-side periodic reclaim driver. The
	// row goes back to `status='queued'` with original scheduling
	// coordinates preserved (§5.5.2's invariant — DO NOT touch
	// scheduled_for/priority). attempt is NOT incremented; the next
	// Dequeue that picks the row up will increment per §1.6. Caller's
	// responsibility to commit.
	ReclaimModeTickRequeue ReclaimMode = "tick_requeue"
)

// ReclaimOutcome distinguishes the three terminal states the primitive
// can leave the row in. The caller (dequeue / tick) uses it to choose
// its post-primitive behavior.
type ReclaimOutcome string

const (
	// ReclaimOutcomeClaimed: InlineClaim path, budget remained, row now
	// owned by ClaimingWorkerID. The Claimed field on ReclaimResult is
	// populated.
	ReclaimOutcomeClaimed ReclaimOutcome = "claimed"

	// ReclaimOutcomeRequeued: TickRequeue path, budget remained, row
	// transitioned to 'queued'. The row will be picked up by the next
	// Dequeue. The Claimed field is nil — the tick site has no use for it.
	ReclaimOutcomeRequeued ReclaimOutcome = "requeued"

	// ReclaimOutcomeDeadLettered: either path, budget exhausted, row
	// transitioned to 'dead_lettered' in place. Per §5.6, the inline
	// caller returns (nil, nil) to its caller; the tick caller records
	// the DLQ in its summary and continues the batch. The Claimed field
	// is nil.
	ReclaimOutcomeDeadLettered ReclaimOutcome = "dead_lettered"

	// ReclaimOutcomeStale: §5.4's post-lock revalidation failed — the
	// row changed state between the caller's SELECT and the primitive's
	// conditional UPDATE (lease was renewed by the prior worker, status
	// transitioned out of 'running', attempt counter moved, etc.). No
	// mutation was performed. The caller's continuation MUST treat
	// Stale as "this row is no longer ours to touch" — Dequeue returns
	// (nil, nil) to its caller (poll again); the tick driver counts the
	// row as stale and continues the batch. Stale is a normal outcome,
	// not an error. The Claimed field is nil.
	ReclaimOutcomeStale ReclaimOutcome = "stale"
)

// ReclaimParams is the input to Reclaim. The caller MUST have:
//   - locked the candidate row FOR UPDATE within `tx`;
//   - verified the candidate's selection predicate (§5.3 preconditions);
//   - for InlineClaim, allocated a non-empty ClaimingWorkerID that is
//     different from PriorWorkerID.
//
// Violations surface as wrapped errors without sentinel types — they
// indicate caller bugs, not runtime conditions.
type ReclaimParams struct {
	Mode             ReclaimMode
	JobID            string
	Attempt          int
	MaxAttempts      int
	PriorWorkerID    string // may be empty when the prior row had current_worker_id IS NULL
	ClaimingWorkerID string // required for InlineClaim; unused for TickRequeue
}

// ReclaimResult is the primitive's per-row output. Exactly one of the
// outcome+claimed shapes is populated:
//
//   - Outcome == Claimed → Claimed is non-nil, fully scanned post-claim row
//   - Outcome == Requeued → Claimed is nil
//   - Outcome == DeadLettered → Claimed is nil
type ReclaimResult struct {
	Outcome ReclaimOutcome
	Claimed *Job
}

// Reclaim is the queue-core reclaim primitive. See SPEC §5.
//
// Reclaim does NOT issue the candidate SELECT — see §5.2's rationale.
// Reclaim does NOT commit the transaction — the caller composes Reclaim
// with whatever else needs to be in the same tx (Dequeue does
// additional work for the queued-path; the tick wraps reclaim calls in
// a per-row SAVEPOINT — see §5.11).
//
// All emitted events follow §5.12's contract. The legacy
// `queue.dequeue.reclaim_closed_prior` / `queue.dequeue.dlq_on_reclaim`
// names are superseded by `queue.reclaim.row.*` here; do not emit both.
func Reclaim(ctx context.Context, tx pgx.Tx, p ReclaimParams) (*ReclaimResult, error) {
	if err := validateReclaimParams(p); err != nil {
		return nil, err
	}

	site := siteFromMode(p.Mode)

	// §5.4 — post-lock revalidation + close prior attempt (always; both
	// branches). ONE conditional UPDATE that BOTH re-checks the row's
	// state under the held lock AND closes the prior attempt. Combining
	// the two into a single statement makes the recheck atomic with the
	// mutation: a row whose state changes between recheck and write
	// cannot exist.
	//
	// The state predicates re-verify what the caller asserted in §5.3:
	//   - j.status = 'running' (row still running)
	//   - j.attempt = $2 (attempt counter unchanged)
	//   - j.lease_expires_at + grace <= now() (lease still expired)
	//   - ja.ended_at IS NULL (attempt still in-flight)
	//
	// Selection is advisory; this UPDATE is authoritative. If
	// RowsAffected == 0, one of the predicates failed under the lock
	// (concurrent renewal, race with another reclaim, Nack closed the
	// attempt, etc.) — we return ReclaimOutcomeStale without mutating.
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
		// §5.4 stale path. One or more state predicates failed under the
		// lock. Caller decides what to do; primitive performs no further
		// mutation.
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

	// §5.6 — budget-exhausted branch. SAME for both modes: dead-letter in
	// place. attempt is NOT incremented; no new job_attempts row.
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
		// validateReclaimParams above rejects unknown modes; this is
		// reachable only if a new mode is added without an arm here.
		return nil, fmt.Errorf("queuecore.Reclaim: unhandled mode %q", p.Mode)
	}
}

// reclaimInlineClaim runs §5.5.1: claim the row under ClaimingWorkerID,
// insert the new attempt, return the post-claim *Job.
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

// reclaimTickRequeue runs §5.5.2: requeue the row, preserving original
// scheduling coordinates. attempt is NOT incremented. No job_attempts
// row is inserted — no handler attempt is starting.
func reclaimTickRequeue(ctx context.Context, tx pgx.Tx, p ReclaimParams) (*ReclaimResult, error) {
	// IMPORTANT: do NOT include scheduled_for or priority in the SET list.
	// §5.5.2's "scheduling intent is preserved" invariant requires that
	// the row reappears in the runnable set with its ORIGINAL coordinates
	// — rewriting them silently changes queue fairness. Reclaim is a
	// recovery path, not a re-enqueue. Reviewers MUST reject any change
	// that adds scheduled_for/priority/enqueued_at to this UPDATE.
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
