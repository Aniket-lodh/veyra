package queuecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrJobNotFound is returned by GetByID and the completion primitives when no job with the given id exists.
var ErrJobNotFound = errors.New("job not found")

// ErrLeaseLost is returned by MarkJobSucceeded / MarkJobFailed when the caller is no longer the owner of the row, or when the row is no longer running.
var ErrLeaseLost = errors.New("lease lost: job is owned by a different worker or no longer running")

// ErrLeaseExpired is returned by MarkJobSucceeded / MarkJobFailed when the caller still owns the row but `lease_expires_at <= now()`.
var ErrLeaseExpired = errors.New("lease expired: lease deadline has passed")

// ErrNotCancellable is returned by Cancel when the job is already in a finished terminal state (succeeded or dead_lettered).
var ErrNotCancellable = errors.New("job is not cancellable: already succeeded or dead-lettered")

// leaseDurationSeconds is the queue's hardcoded lease length.
const leaseDurationSeconds = 30

// Repository owns all SQL against the `jobs` table.
type Repository struct {
	pool *pgxpool.Pool
}

func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// CreateParams is the input to Create.
type CreateParams struct {
	ID             string
	Handler        string
	Queue          string
	Priority       int
	MaxAttempts    int
	Backoff        BackoffStrategy
	Payload        json.RawMessage
	ScheduledFor   *time.Time // nil → DB default (now())
	IdempotencyKey *string
}

// Create inserts a new job and returns the fully populated row.
func (r *Repository) Create(ctx context.Context, p CreateParams) (*Job, error) {
	backoffJSON, err := json.Marshal(p.Backoff)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.Create: marshal backoff: %w", err)
	}

	const insertSQL = `
		INSERT INTO jobs (
			id, handler, queue, priority, idempotency_key,
			payload, max_attempts, backoff, scheduled_for
		) VALUES (
			$1, $2, $3, $4, $5,
			$6, $7, $8, COALESCE($9, now())
		)
		ON CONFLICT (queue, idempotency_key)
			WHERE idempotency_key IS NOT NULL
			DO NOTHING
		RETURNING ` + jobColumns

	row := r.pool.QueryRow(ctx, insertSQL,
		p.ID, p.Handler, p.Queue, p.Priority, p.IdempotencyKey,
		[]byte(p.Payload), p.MaxAttempts, backoffJSON, p.ScheduledFor,
	)

	job, err := scanJob(row)
	if err == nil {
		return job, nil
	}

	// ON CONFLICT DO NOTHING produces no row when an idempotency collision occurs.
	if errors.Is(err, pgx.ErrNoRows) && p.IdempotencyKey != nil {
		return r.getByIdempotencyKey(ctx, p.Queue, *p.IdempotencyKey)
	}
	return nil, fmt.Errorf("queuecore.Repository.Create: insert: %w", err)
}

// GetByID returns the job with the given id, or ErrJobNotFound.
func (r *Repository) GetByID(ctx context.Context, id string) (*Job, error) {
	const query = `SELECT ` + jobColumns + ` FROM jobs WHERE id = $1`
	job, err := scanJob(r.pool.QueryRow(ctx, query, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrJobNotFound
		}
		return nil, fmt.Errorf("queuecore.Repository.GetByID: %w", err)
	}
	return job, nil
}

// ListParams is the input to List and Count.
type ListParams struct {
	Limit    int
	Offset   int
	Statuses []JobStatus // empty = any status
	Queues   []string    // empty = any queue
	Handlers []string    // empty = any handler; exact match, multiple OR'd
	Search   string      // empty = no search; case-insensitive prefix on id and handler
}

// List returns jobs ordered by enqueue time, newest first, narrowed by p's filters.
func (r *Repository) List(ctx context.Context, p ListParams) ([]*Job, error) {
	where, args := buildListFilters(p)
	query := `SELECT ` + jobColumns + ` FROM jobs` + where +
		` ORDER BY enqueued_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args)+1) +
		` OFFSET $` + strconv.Itoa(len(args)+2)
	args = append(args, p.Limit, p.Offset)

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.List: query: %w", err)
	}
	defer rows.Close()

	jobs := make([]*Job, 0, p.Limit)
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, fmt.Errorf("queuecore.Repository.List: scan: %w", err)
		}
		jobs = append(jobs, j)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.List: rows: %w", err)
	}
	return jobs, nil
}

// Count returns the total number of jobs matching p's filters (ignoring Limit and Offset).
func (r *Repository) Count(ctx context.Context, p ListParams) (int, error) {
	where, args := buildListFilters(p)
	query := `SELECT count(*) FROM jobs` + where
	var n int
	if err := r.pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("queuecore.Repository.Count: %w", err)
	}
	return n, nil
}

// buildListFilters renders the WHERE clause and arg list shared by List and Count.
func buildListFilters(p ListParams) (string, []any) {
	var (
		clauses []string
		args    []any
	)
	if len(p.Statuses) > 0 {
		statusStrs := make([]string, len(p.Statuses))
		for i, s := range p.Statuses {
			statusStrs[i] = string(s)
		}
		args = append(args, statusStrs)
		clauses = append(clauses, "status::text = ANY($"+strconv.Itoa(len(args))+")")
	}
	if len(p.Queues) > 0 {
		args = append(args, p.Queues)
		clauses = append(clauses, "queue = ANY($"+strconv.Itoa(len(args))+")")
	}
	if len(p.Handlers) > 0 {
		args = append(args, p.Handlers)
		clauses = append(clauses, "handler = ANY($"+strconv.Itoa(len(args))+")")
	}
	if p.Search != "" {
		// ILIKE on id and handler; the % is appended by the SQL so the input is taken literally — no LIKE-metachar injection from the user.
		args = append(args, p.Search+"%")
		ph := "$" + strconv.Itoa(len(args))
		clauses = append(clauses, "(id ILIKE "+ph+" OR handler ILIKE "+ph+")")
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

// ClaimNextJob atomically takes ownership of one runnable job and returns it, or (nil, nil) when nothing is available.
func (r *Repository) ClaimNextJob(ctx context.Context, workerID string, queues, handlers []string) (*Job, error) {
	if workerID == "" {
		return nil, errors.New("queuecore.Repository.ClaimNextJob: workerID is required")
	}
	if len(queues) == 0 {
		return nil, errors.New("queuecore.Repository.ClaimNextJob: queues must be non-empty")
	}
	if len(handlers) == 0 {
		return nil, errors.New("queuecore.Repository.ClaimNextJob: handlers must be non-empty")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: begin tx: %w", err)
	}
	// Safe to call after Commit — pgx returns ErrTxClosed, which we discard.
	defer func() { _ = tx.Rollback(ctx) }()

	// (1) Pick one candidate under a row lock.
	const selectCandidateSQL = `
		SELECT id, status::text, attempt, max_attempts, current_worker_id
		FROM jobs
		WHERE queue = ANY($1)
		  AND handler = ANY($3)
		  AND (
		      (status = 'queued'  AND scheduled_for                                    <= now())
		   OR (status = 'running' AND lease_expires_at + make_interval(secs => $2)     <= now())
		  )
		ORDER BY priority DESC, scheduled_for ASC
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`
	var (
		candidateID      string
		priorStatusStr   string
		priorAttempt     int
		priorMaxAttempts int
		priorWorkerIDPtr *string
	)
	err = tx.QueryRow(ctx, selectCandidateSQL, queues, ReclaimGraceSeconds, handlers).
		Scan(&candidateID, &priorStatusStr, &priorAttempt, &priorMaxAttempts, &priorWorkerIDPtr)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.DebugContext(ctx, "queue.dequeue.no_candidate",
				"workerId", workerID,
				"queues", queues,
				"handlers", handlers,
			)
			return nil, nil
		}
		return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: select candidate: %w", err)
	}

	isReclaim := JobStatus(priorStatusStr) == StatusRunning
	priorWorkerID := ""
	if priorWorkerIDPtr != nil {
		priorWorkerID = *priorWorkerIDPtr
	}
	slog.DebugContext(ctx, "queue.dequeue.candidate",
		"workerId", workerID,
		"jobId", candidateID,
		"priorStatus", priorStatusStr,
		"attemptBefore", priorAttempt,
		"wasReclaim", isReclaim,
	)

	if isReclaim {
		result, reclaimErr := Reclaim(ctx, tx, ReclaimParams{
			Mode:             ReclaimModeInlineClaim,
			JobID:            candidateID,
			Attempt:          priorAttempt,
			MaxAttempts:      priorMaxAttempts,
			PriorWorkerID:    priorWorkerID,
			ClaimingWorkerID: workerID,
		})
		if reclaimErr != nil {
			return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: reclaim: %w", reclaimErr)
		}
		switch result.Outcome {
		case ReclaimOutcomeDeadLettered:
			// §5.6 — budget-exhausted reclaim DLQ.
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: commit dlq: %w", commitErr)
			}
			return nil, nil
		case ReclaimOutcomeClaimed:
			// §5.5.1 — primitive performed the claim and the new attempt insert.
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: commit reclaim: %w", commitErr)
			}
			return result.Claimed, nil
		case ReclaimOutcomeStale:
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: commit stale: %w", commitErr)
			}
			return nil, nil
		default:
			return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: unexpected reclaim outcome %q", result.Outcome)
		}
	}

	// (3) Queued path — fresh candidate.
	const claimUpdateSQL = `
		UPDATE jobs
		SET status            = 'running',
		    current_worker_id = $1,
		    lease_expires_at  = now() + INTERVAL '30 seconds',
		    attempt           = attempt + 1,
		    started_at        = COALESCE(started_at, now())
		WHERE id = $2
		RETURNING ` + jobColumns
	claimed, err := scanJob(tx.QueryRow(ctx, claimUpdateSQL, workerID, candidateID))
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: claim update: %w", err)
	}

	// (4) Append the in-flight attempt row.
	const insertAttemptSQL = `
		INSERT INTO job_attempts (job_id, attempt_number, worker_id, started_at)
		VALUES ($1, $2, $3, now())
	`
	_, err = tx.Exec(ctx, insertAttemptSQL, claimed.ID, claimed.Attempt, workerID)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: insert attempt: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ClaimNextJob: commit: %w", err)
	}

	leaseExpires := "(unset)"
	if claimed.LeaseExpiresAt != nil {
		leaseExpires = claimed.LeaseExpiresAt.Format(time.RFC3339Nano)
	}
	slog.InfoContext(ctx, "queue.dequeue.claimed",
		"workerId", workerID,
		"jobId", claimed.ID,
		"queue", claimed.Queue,
		"handler", claimed.Handler,
		"attempt", claimed.Attempt,
		"leaseExpiresAt", leaseExpires,
		"leaseDurationSeconds", leaseDurationSeconds,
		"wasReclaim", false,
	)

	return claimed, nil
}

// SucceedParams is the input to MarkJobSucceeded.
type SucceedParams struct {
	WorkerID string
	JobID    string
	Result   json.RawMessage
}

// RenewParams is the input to RenewLease.
type RenewParams struct {
	WorkerID string
	JobID    string
}

// FailParams is the input to MarkJobFailed.
type FailParams struct {
	WorkerID  string
	JobID     string
	Error     JobError
	Permanent bool
}

// MarkJobSucceeded closes the in-flight attempt with outcome='succeeded' and transitions the job to status='succeeded'.
func (r *Repository) MarkJobSucceeded(ctx context.Context, p SucceedParams) (*Job, error) {
	if p.WorkerID == "" {
		return nil, errors.New("queuecore.Repository.MarkJobSucceeded: workerID is required")
	}
	if p.JobID == "" {
		return nil, errors.New("queuecore.Repository.MarkJobSucceeded: jobID is required")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobSucceeded: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	attempt, _, err := r.lockJobForCompletion(ctx, tx, "queue.ack.guard_failed", p.WorkerID, p.JobID)
	if err != nil {
		// Sentinels propagate through %w; pgx errors carry their wrap from the helper.
		return nil, fmt.Errorf("queuecore.Repository.MarkJobSucceeded: %w", err)
	}

	const closeAttemptSQL = `
		UPDATE job_attempts
		SET outcome  = 'succeeded',
		    ended_at = now()
		WHERE job_id         = $1
		  AND attempt_number = $2
		  AND ended_at IS NULL
	`
	_, err = tx.Exec(ctx, closeAttemptSQL, p.JobID, attempt)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobSucceeded: close attempt: %w", err)
	}

	const updateJobSQL = `
		UPDATE jobs
		SET status            = 'succeeded',
		    completed_at      = now(),
		    current_worker_id = NULL,
		    lease_expires_at  = NULL,
		    result            = $1
		WHERE id = $2
		RETURNING ` + jobColumns

	var resultArg any
	if len(p.Result) > 0 {
		resultArg = []byte(p.Result)
	}
	job, err := scanJob(tx.QueryRow(ctx, updateJobSQL, resultArg, p.JobID))
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobSucceeded: update job: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobSucceeded: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.ack.success",
		"workerId", p.WorkerID,
		"jobId", p.JobID,
		"attempt", attempt,
		"hadResult", len(p.Result) > 0,
	)
	return job, nil
}

// MarkJobFailed closes the in-flight attempt with outcome='failed' and either dead-letters the job (permanent.
func (r *Repository) MarkJobFailed(ctx context.Context, p FailParams) (*Job, error) {
	if p.WorkerID == "" {
		return nil, errors.New("queuecore.Repository.MarkJobFailed: workerID is required")
	}
	if p.JobID == "" {
		return nil, errors.New("queuecore.Repository.MarkJobFailed: jobID is required")
	}
	if p.Error.Class == "" {
		return nil, errors.New("queuecore.Repository.MarkJobFailed: error.class is required")
	}
	if p.Error.Message == "" {
		return nil, errors.New("queuecore.Repository.MarkJobFailed: error.message is required")
	}
	if p.Error.OccurredAt.IsZero() {
		p.Error.OccurredAt = time.Now()
	}

	errJSON, err := json.Marshal(p.Error)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: marshal error: %w", err)
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	attempt, maxAttempts, err := r.lockJobForCompletion(ctx, tx, "queue.nack.guard_failed", p.WorkerID, p.JobID)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: %w", err)
	}

	const closeAttemptSQL = `
		UPDATE job_attempts
		SET outcome       = 'failed',
		    ended_at      = now(),
		    error_class   = $1,
		    error_message = $2
		WHERE job_id         = $3
		  AND attempt_number = $4
		  AND ended_at IS NULL
	`
	_, err = tx.Exec(ctx, closeAttemptSQL, p.Error.Class, p.Error.Message, p.JobID, attempt)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: close attempt: %w", err)
	}

	// Terminality: permanent disposition OR attempt budget exhausted (§3.4 / §7.3).
	budgetExhausted := attempt >= maxAttempts
	terminal := p.Permanent || budgetExhausted

	disposition := "retry"
	switch {
	case p.Permanent:
		disposition = "permanent"
	case budgetExhausted:
		disposition = "budget_exhausted"
	}

	var (
		job          *Job
		delaySeconds float64 // 0 in the dead-letter branch
	)

	if terminal {
		// Permanent and budget-exhausted share the same row shape (§7.3).
		const updateDeadLetterSQL = `
			UPDATE jobs
			SET status            = 'dead_lettered',
			    dead_lettered_at  = now(),
			    error             = $1,
			    current_worker_id = NULL,
			    lease_expires_at  = NULL
			WHERE id = $2
			RETURNING ` + jobColumns
		job, err = scanJob(tx.QueryRow(ctx, updateDeadLetterSQL, errJSON, p.JobID))
		if err != nil {
			return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: update dlq: %w", err)
		}
	} else {
		var backoffJSON []byte
		if err = tx.QueryRow(ctx, `SELECT backoff FROM jobs WHERE id = $1`, p.JobID).Scan(&backoffJSON); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: read backoff: %w", err)
		}
		var backoff BackoffStrategy
		if err = json.Unmarshal(backoffJSON, &backoff); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: unmarshal backoff: %w", err)
		}
		// SPEC §3.5.1–§3.5.2: jitter sampled exactly once here.
		delaySeconds = computeRetryDelaySeconds(backoff, attempt)

		// next_retry_at uses the DB clock (`now()`) for consistency with the lease deadlines (§4.4 — DB-clock authoritative).
		const updateRetryableSQL = `
			UPDATE jobs
			SET status            = 'failed',
			    error             = $1,
			    current_worker_id = NULL,
			    lease_expires_at  = NULL,
			    next_retry_at     = now() + ($3 * INTERVAL '1 second')
			WHERE id = $2
			RETURNING ` + jobColumns
		job, err = scanJob(tx.QueryRow(ctx, updateRetryableSQL, errJSON, p.JobID, delaySeconds))
		if err != nil {
			return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: update retryable: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.MarkJobFailed: commit: %w", err)
	}

	slog.InfoContext(ctx, "queue.nack.recorded",
		"workerId", p.WorkerID,
		"jobId", p.JobID,
		"attempt", attempt,
		"maxAttempts", maxAttempts,
		"terminal", terminal,
		"errorClass", p.Error.Class,
		"disposition", disposition,
	)
	if p.Permanent {
		slog.WarnContext(ctx, "queue.dlq.permanent",
			"workerId", p.WorkerID,
			"jobId", p.JobID,
			"handler", job.Handler,
			"attempt", attempt,
			"maxAttempts", maxAttempts,
			"errorClass", p.Error.Class,
		)
	}
	// Retry-scheduled event mirrors SPEC §3.5.10.
	if !terminal && job.NextRetryAt != nil {
		slog.InfoContext(ctx, "queue.retry.scheduled",
			"event", "queue.retry.scheduled",
			"jobId", p.JobID,
			"queue", job.Queue,
			"handler", job.Handler,
			"attempt", attempt,
			"maxAttempts", maxAttempts,
			"nextRetryAt", job.NextRetryAt.Format(time.RFC3339Nano),
			"delaySeconds", delaySeconds,
			"errorClass", p.Error.Class,
		)
	}
	return job, nil
}

// RenewLease pushes lease_expires_at forward by the configured lease duration for the (worker, job) pair.
func (r *Repository) RenewLease(ctx context.Context, p RenewParams) (*Job, error) {
	if p.WorkerID == "" {
		return nil, errors.New("queuecore.Repository.RenewLease: workerID is required")
	}
	if p.JobID == "" {
		return nil, errors.New("queuecore.Repository.RenewLease: jobID is required")
	}

	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.RenewLease: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	attempt, _, err := r.lockJobForCompletion(ctx, tx, "queue.renew.guard_failed", p.WorkerID, p.JobID)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.RenewLease: %w", err)
	}

	// Single-column UPDATE: only lease_expires_at moves.
	const renewSQL = `
		UPDATE jobs
		SET lease_expires_at = now() + INTERVAL '30 seconds'
		WHERE id = $1
		RETURNING ` + jobColumns
	job, err := scanJob(tx.QueryRow(ctx, renewSQL, p.JobID))
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.RenewLease: update lease: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.RenewLease: commit: %w", err)
	}

	newLease := "(unset)"
	if job.LeaseExpiresAt != nil {
		newLease = job.LeaseExpiresAt.Format(time.RFC3339Nano)
	}
	slog.DebugContext(ctx, "queue.renew.success",
		"workerId", p.WorkerID,
		"jobId", p.JobID,
		"attempt", attempt,
		"newLeaseExpiresAt", newLease,
		"leaseDurationSeconds", leaseDurationSeconds,
	)
	return job, nil
}

// lockJobForCompletion is the shared lock+guard path for Ack, Nack, and RenewLease — every operation that.
func (r *Repository) lockJobForCompletion(
	ctx context.Context,
	tx pgx.Tx,
	eventName, workerID, jobID string,
) (attempt int, maxAttempts int, err error) {
	const lockSQL = `
		SELECT status::text,
		       current_worker_id,
		       attempt,
		       max_attempts,
		       COALESCE(lease_expires_at > now(), FALSE) AS lease_valid
		FROM jobs
		WHERE id = $1
		FOR UPDATE
	`
	var (
		statusStr       string
		currentWorkerID *string
		leaseValid      bool
	)
	err = tx.QueryRow(ctx, lockSQL, jobID).Scan(&statusStr, &currentWorkerID, &attempt, &maxAttempts, &leaseValid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(ctx, eventName,
				"workerId", workerID,
				"jobId", jobID,
				"reason", "not_found",
			)
			return 0, 0, ErrJobNotFound
		}
		return 0, 0, fmt.Errorf("lock job: %w", err)
	}

	if statusStr != string(StatusRunning) || currentWorkerID == nil || *currentWorkerID != workerID {
		observedWorker := ""
		if currentWorkerID != nil {
			observedWorker = *currentWorkerID
		}
		slog.WarnContext(ctx, eventName,
			"workerId", workerID,
			"jobId", jobID,
			"reason", "lease_lost",
			"observedStatus", statusStr,
			"observedWorkerId", observedWorker,
		)
		return 0, 0, ErrLeaseLost
	}

	if !leaseValid {
		slog.WarnContext(ctx, eventName,
			"workerId", workerID,
			"jobId", jobID,
			"reason", "lease_expired",
		)
		return 0, 0, ErrLeaseExpired
	}

	return attempt, maxAttempts, nil
}

// getByIdempotencyKey is the read used by Create's idempotency fallback.
func (r *Repository) getByIdempotencyKey(ctx context.Context, queue, key string) (*Job, error) {
	const query = `SELECT ` + jobColumns + ` FROM jobs WHERE queue = $1 AND idempotency_key = $2`
	job, err := scanJob(r.pool.QueryRow(ctx, query, queue, key))
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.getByIdempotencyKey: %w", err)
	}
	return job, nil
}

// jobColumns is the SELECT/RETURNING list, in scanJob's column order.
const jobColumns = `
	id, handler, queue, priority, idempotency_key,
	payload, result, error,
	attempt, max_attempts, backoff,
	enqueued_at, scheduled_for, started_at,
	completed_at, cancelled_at, dead_lettered_at,
	current_worker_id, lease_expires_at, next_retry_at,
	status::text
`

// scanJob reads one row of jobColumns into a Job, decoding the JSONB columns (error, backoff) as it goes.
func scanJob(row pgx.Row) (*Job, error) {
	var (
		j           Job
		errorBytes  []byte
		backoffJSON []byte
		statusStr   string
	)
	if err := row.Scan(
		&j.ID, &j.Handler, &j.Queue, &j.Priority, &j.IdempotencyKey,
		&j.Payload, &j.Result, &errorBytes,
		&j.Attempt, &j.MaxAttempts, &backoffJSON,
		&j.EnqueuedAt, &j.ScheduledFor, &j.StartedAt,
		&j.CompletedAt, &j.CancelledAt, &j.DeadLetteredAt,
		&j.CurrentWorkerID, &j.LeaseExpiresAt, &j.NextRetryAt,
		&statusStr,
	); err != nil {
		return nil, err
	}
	j.Status = JobStatus(statusStr)
	if len(errorBytes) > 0 {
		var jerr JobError
		if err := json.Unmarshal(errorBytes, &jerr); err != nil {
			return nil, fmt.Errorf("scanJob: unmarshal error column: %w", err)
		}
		j.Error = &jerr
	}
	if err := json.Unmarshal(backoffJSON, &j.Backoff); err != nil {
		return nil, fmt.Errorf("scanJob: unmarshal backoff column: %w", err)
	}
	return &j, nil
}

// ListAttempts returns the full attempt history for a job, oldest attempt first.
func (r *Repository) ListAttempts(ctx context.Context, jobID string) ([]*Attempt, error) {
	const query = `
		SELECT job_id, attempt_number, worker_id,
		       started_at, ended_at,
		       outcome::text, error_class, error_message
		FROM job_attempts
		WHERE job_id = $1
		ORDER BY attempt_number ASC
	`
	rows, err := r.pool.Query(ctx, query, jobID)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ListAttempts: query: %w", err)
	}
	defer rows.Close()

	out := make([]*Attempt, 0)
	for rows.Next() {
		var (
			a          Attempt
			outcomeStr *string
		)
		if err := rows.Scan(
			&a.JobID, &a.AttemptNumber, &a.WorkerID,
			&a.StartedAt, &a.EndedAt,
			&outcomeStr, &a.ErrorClass, &a.ErrorMessage,
		); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.ListAttempts: scan: %w", err)
		}
		if outcomeStr != nil {
			oc := AttemptOutcome(*outcomeStr)
			a.Outcome = &oc
		}
		out = append(out, &a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ListAttempts: rows: %w", err)
	}
	return out, nil
}

// QueueStats returns a single snapshot of queue health used by the operator dashboard.
func (r *Repository) QueueStats(ctx context.Context) (*QueueStats, error) {
	const totalsSQL = `
		SELECT
		  count(*) FILTER (WHERE status = 'queued'        AND scheduled_for <= now()) AS queued,
		  count(*) FILTER (WHERE status = 'queued'        AND scheduled_for >  now()) AS scheduled,
		  count(*) FILTER (WHERE status = 'running')                                  AS running,
		  count(*) FILTER (WHERE status = 'succeeded')                                AS succeeded,
		  count(*) FILTER (WHERE status = 'failed')                                   AS failed,
		  count(*) FILTER (WHERE status = 'dead_lettered')                            AS dead_lettered,
		  count(*) FILTER (WHERE status = 'cancelled')                                AS cancelled
		FROM jobs
	`
	var totals StatusCounts
	if err := r.pool.QueryRow(ctx, totalsSQL).Scan(
		&totals.Queued, &totals.Scheduled, &totals.Running,
		&totals.Succeeded, &totals.Failed, &totals.DeadLettered, &totals.Cancelled,
	); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.QueueStats: totals: %w", err)
	}

	const perQueueSQL = `
		SELECT
		  queue,
		  count(*) FILTER (WHERE status IN ('queued') AND scheduled_for <= now()) AS depth,
		  count(*) FILTER (WHERE status = 'running')                              AS in_flight,
		  count(*) FILTER (WHERE status = 'succeeded'    AND completed_at      >= now() - INTERVAL '24 hours') AS succeeded_24h,
		  count(*) FILTER (WHERE status = 'failed'       AND completed_at      >= now() - INTERVAL '24 hours') AS failed_24h,
		  count(*) FILTER (WHERE status = 'dead_lettered' AND dead_lettered_at >= now() - INTERVAL '24 hours') AS dead_lettered_24h
		FROM jobs
		GROUP BY queue
		ORDER BY queue ASC
	`
	rows, err := r.pool.Query(ctx, perQueueSQL)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.QueueStats: per-queue: %w", err)
	}
	defer rows.Close()
	perQueue := make([]QueueAggregate, 0)
	for rows.Next() {
		var q QueueAggregate
		if err := rows.Scan(
			&q.Name, &q.Depth, &q.InFlight,
			&q.Succeeded24h, &q.Failed24h, &q.DeadLettered24h,
		); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.QueueStats: scan: %w", err)
		}
		perQueue = append(perQueue, q)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.QueueStats: rows: %w", err)
	}
	return &QueueStats{Totals: totals, PerQueue: perQueue}, nil
}

// ListRunningLeases returns every job currently held under lease, narrowed to the given worker ids when the slice is non-empty.
func (r *Repository) ListRunningLeases(ctx context.Context, workerIDs []string) ([]*RunningLease, error) {
	var (
		query string
		args  []any
	)
	if len(workerIDs) == 0 {
		query = `
			SELECT id, handler, queue, attempt, current_worker_id,
			       started_at, lease_expires_at
			FROM jobs
			WHERE status = 'running' AND current_worker_id IS NOT NULL
			ORDER BY lease_expires_at ASC
		`
	} else {
		query = `
			SELECT id, handler, queue, attempt, current_worker_id,
			       started_at, lease_expires_at
			FROM jobs
			WHERE status = 'running' AND current_worker_id = ANY($1)
			ORDER BY lease_expires_at ASC
		`
		args = []any{workerIDs}
	}
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ListRunningLeases: query: %w", err)
	}
	defer rows.Close()

	out := make([]*RunningLease, 0)
	for rows.Next() {
		var (
			l        RunningLease
			workerID *string
		)
		if err := rows.Scan(
			&l.JobID, &l.Handler, &l.Queue, &l.Attempt, &workerID,
			&l.StartedAt, &l.LeaseExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("queuecore.Repository.ListRunningLeases: scan: %w", err)
		}
		if workerID != nil {
			l.WorkerID = *workerID
		}
		out = append(out, &l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("queuecore.Repository.ListRunningLeases: rows: %w", err)
	}
	return out, nil
}
