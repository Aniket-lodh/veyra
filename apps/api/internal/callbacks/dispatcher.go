// Package callbacks runs the background completion webhook dispatcher.
package callbacks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxCallbackAttempts  = 5
	maxErrorSnippetBytes = 256
)

// Config contains dispatcher tuning parameters.
type Config struct {
	Interval    time.Duration
	BatchLimit  int
	Timeout     time.Duration
	Concurrency int
	Secret      string
}

// Dispatcher coordinates claiming and delivering completion webhooks.
type Dispatcher struct {
	pool        *pgxpool.Pool
	interval    time.Duration
	batchLimit  int
	timeout     time.Duration
	concurrency int
	secret      string
	client      *http.Client
	sem         chan struct{}
	wg          sync.WaitGroup
}

// NewDispatcher constructs the completion webhook dispatcher.
func NewDispatcher(pool *pgxpool.Pool, cfg Config) *Dispatcher {
	interval := cfg.Interval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	batchLimit := cfg.BatchLimit
	if batchLimit < 1 {
		batchLimit = 50
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	concurrency := cfg.Concurrency
	if concurrency < 1 {
		concurrency = 25
	}

	return &Dispatcher{
		pool:        pool,
		interval:    interval,
		batchLimit:  batchLimit,
		timeout:     timeout,
		concurrency: concurrency,
		secret:      cfg.Secret,
		client:      &http.Client{Timeout: timeout},
		sem:         make(chan struct{}, concurrency),
	}
}

// SetHTTPClient overrides the default HTTP client (primarily for testing).
func (d *Dispatcher) SetHTTPClient(client *http.Client) {
	d.client = client
}

// Run drives one tick per interval until ctx is cancelled.
func (d *Dispatcher) Run(ctx context.Context) error {
	slog.InfoContext(ctx, "queue.callback.dispatcher.started",
		"event", "queue.callback.dispatcher.started",
		"intervalSeconds", int(d.interval/time.Second),
		"batchLimit", d.batchLimit,
		"concurrency", d.concurrency,
		"timeoutSeconds", int(d.timeout/time.Second),
		"hasSecret", d.secret != "",
	)

	t := time.NewTicker(d.interval)
	defer t.Stop()

	// Immediate tick on boot so accumulated pending callbacks are dispatched immediately.
	if err := d.tick(ctx); err != nil {
		slog.ErrorContext(ctx, "queue.callback.dispatcher.tick_failed",
			"event", "queue.callback.dispatcher.tick_failed",
			"err", err.Error(),
		)
	}

	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "queue.callback.dispatcher.stopping",
				"event", "queue.callback.dispatcher.stopping",
				"reason", ctxErrString(ctx.Err()),
			)
			d.wg.Wait()
			slog.InfoContext(ctx, "queue.callback.dispatcher.stopped",
				"event", "queue.callback.dispatcher.stopped",
			)
			return nil
		case <-t.C:
			if err := d.tick(ctx); err != nil {
				slog.ErrorContext(ctx, "queue.callback.dispatcher.tick_failed",
					"event", "queue.callback.dispatcher.tick_failed",
					"err", err.Error(),
				)
			}
		}
	}
}

type claimedJob struct {
	ID               string
	CallbackURL      string
	CallbackAttempts int
	Status           string
	Handler          string
	Queue            string
	Attempt          int
	MaxAttempts      int
	Payload          json.RawMessage
	Result           json.RawMessage
	Error            *queuecore.JobError
	EnqueuedAt       time.Time
	StartedAt        *time.Time
	CompletedAt      *time.Time
	CancelledAt      *time.Time
	DeadLetteredAt   *time.Time
}

// tick claims due callbacks and launches delivery goroutines bounded by concurrency.
func (d *Dispatcher) tick(ctx context.Context) error {
	leaseSeconds := int(d.timeout.Seconds()) + 15
	if leaseSeconds < 30 {
		leaseSeconds = 30
	}

	const claimSQL = `
		WITH due AS (
			SELECT id
			FROM jobs
			WHERE callback_url IS NOT NULL
			  AND status IN ('succeeded', 'dead_lettered', 'cancelled')
			  AND (
				  callback_status = 'pending'
				  OR (callback_status = 'running' AND callback_next_retry_at <= now())
			  )
			  AND (callback_next_retry_at IS NULL OR callback_next_retry_at <= now())
			ORDER BY callback_next_retry_at ASC NULLS FIRST, id ASC
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		UPDATE jobs j
		SET callback_status = 'running',
		    callback_attempts = j.callback_attempts + 1,
		    callback_next_retry_at = now() + make_interval(secs => $2::int)
		FROM due
		WHERE j.id = due.id
		RETURNING j.id, j.callback_url, j.callback_attempts, j.status,
		          j.handler, j.queue, j.attempt, j.max_attempts,
		          j.payload, j.result, j.error, j.enqueued_at,
		          j.started_at, j.completed_at, j.cancelled_at, j.dead_lettered_at
	`

	rows, err := d.pool.Query(ctx, claimSQL, d.batchLimit, leaseSeconds)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return fmt.Errorf("callbacks.Dispatcher.tick: claim query: %w", err)
	}
	defer rows.Close()

	jobs := make([]claimedJob, 0)
	for rows.Next() {
		var (
			j          claimedJob
			errorBytes []byte
		)
		if err := rows.Scan(
			&j.ID, &j.CallbackURL, &j.CallbackAttempts, &j.Status,
			&j.Handler, &j.Queue, &j.Attempt, &j.MaxAttempts,
			&j.Payload, &j.Result, &errorBytes, &j.EnqueuedAt,
			&j.StartedAt, &j.CompletedAt, &j.CancelledAt, &j.DeadLetteredAt,
		); err != nil {
			return fmt.Errorf("callbacks.Dispatcher.tick: scan: %w", err)
		}
		if len(errorBytes) > 0 {
			var jerr queuecore.JobError
			if err := json.Unmarshal(errorBytes, &jerr); err == nil {
				j.Error = &jerr
			}
		}
		jobs = append(jobs, j)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("callbacks.Dispatcher.tick: rows: %w", err)
	}
	rows.Close()

	if len(jobs) == 0 {
		return nil
	}

	slog.DebugContext(ctx, "queue.callback.claimed",
		"event", "queue.callback.claimed",
		"count", len(jobs),
	)

	for _, job := range jobs {
		// Acquire concurrency semaphore slot.
		select {
		case <-ctx.Done():
			return nil
		case d.sem <- struct{}{}:
		}

		d.wg.Add(1)
		go func(target claimedJob) {
			defer func() {
				<-d.sem
				d.wg.Done()
			}()
			d.deliver(ctx, target)
		}(job)
	}

	return nil
}

// WebhookPayload is the JSON document delivered to callback_url.
type WebhookPayload struct {
	Event            string              `json:"event"`
	JobID            string              `json:"jobId"`
	Queue            string              `json:"queue"`
	Handler          string              `json:"handler"`
	Status           string              `json:"status"`
	Attempt          int                 `json:"attempt"`
	MaxAttempts      int                 `json:"maxAttempts"`
	Payload          json.RawMessage     `json:"payload"`
	Result           any                 `json:"result"`
	Error            *queuecore.JobError `json:"error"`
	EnqueuedAt       time.Time           `json:"enqueuedAt"`
	StartedAt        *time.Time          `json:"startedAt"`
	CompletedAt      *time.Time          `json:"completedAt"`
	CancelledAt      *time.Time          `json:"cancelledAt"`
	DeadLetteredAt   *time.Time          `json:"deadLetteredAt"`
	CallbackAttempts int                 `json:"callbackAttempts"`
}

// deliver performs one outbound HTTP delivery attempt and records outcome in PostgreSQL.
func (d *Dispatcher) deliver(ctx context.Context, j claimedJob) {
	start := time.Now()

	var result any
	if len(j.Result) > 0 {
		result = json.RawMessage(j.Result)
	}

	payloadObj := WebhookPayload{
		Event:            "job.completed",
		JobID:            j.ID,
		Queue:            j.Queue,
		Handler:          j.Handler,
		Status:           j.Status,
		Attempt:          j.Attempt,
		MaxAttempts:      j.MaxAttempts,
		Payload:          j.Payload,
		Result:           result,
		Error:            j.Error,
		EnqueuedAt:       j.EnqueuedAt,
		StartedAt:        j.StartedAt,
		CompletedAt:      j.CompletedAt,
		CancelledAt:      j.CancelledAt,
		DeadLetteredAt:   j.DeadLetteredAt,
		CallbackAttempts: j.CallbackAttempts,
	}

	bodyBytes, err := json.Marshal(payloadObj)
	if err != nil {
		slog.ErrorContext(ctx, "queue.callback.marshal_failed",
			"jobId", j.ID,
			"err", err.Error(),
		)
		d.recordFailure(ctx, j.ID, fmt.Sprintf("marshal payload: %v", err))
		return
	}

	reqCtx, reqCancel := context.WithTimeout(ctx, d.timeout)
	defer reqCancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, j.CallbackURL, bytes.NewReader(bodyBytes))
	if err != nil {
		d.recordFailure(ctx, j.ID, fmt.Sprintf("build request: %v", err))
		return
	}

	timestampStr := time.Now().UTC().Format(time.RFC3339)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Veyra-Webhook/1.0")
	req.Header.Set("X-Veyra-Event", "job.completed")
	req.Header.Set("X-Veyra-Job-Id", j.ID)
	req.Header.Set("X-Veyra-Status", j.Status)
	req.Header.Set("X-Veyra-Attempt", strconv.Itoa(j.Attempt))
	req.Header.Set("X-Veyra-Delivery-Attempt", strconv.Itoa(j.CallbackAttempts))
	req.Header.Set("X-Veyra-Timestamp", timestampStr)

	if d.secret != "" {
		req.Header.Set("X-Veyra-Signature", computeSignature(d.secret, bodyBytes))
	}

	resp, reqErr := d.client.Do(req)
	duration := time.Since(start)

	if reqErr != nil {
		errDetail := fmt.Sprintf("HTTP request error: %v", reqErr)
		slog.WarnContext(ctx, "queue.callback.request_failed",
			"event", "queue.callback.request_failed",
			"jobId", j.ID,
			"url", j.CallbackURL,
			"attempt", j.CallbackAttempts,
			"err", errDetail,
			"durationMs", duration.Milliseconds(),
		)
		d.handleRetryOrFailure(ctx, j, errDetail)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	// 2xx Success.
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		slog.InfoContext(ctx, "queue.callback.delivered",
			"event", "queue.callback.delivered",
			"jobId", j.ID,
			"url", j.CallbackURL,
			"attempt", j.CallbackAttempts,
			"status", resp.StatusCode,
			"durationMs", duration.Milliseconds(),
		)
		d.recordDelivered(ctx, j.ID)
		return
	}

	snippet := readBodySnippet(resp.Body)
	errDetail := fmt.Sprintf("HTTP %d", resp.StatusCode)
	if snippet != "" {
		errDetail = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, snippet)
	}

	// 4xx Non-Retryable (excluding 408 & 429).
	if isNonRetryableStatus(resp.StatusCode) {
		slog.ErrorContext(ctx, "queue.callback.failed",
			"event", "queue.callback.failed",
			"jobId", j.ID,
			"url", j.CallbackURL,
			"attempt", j.CallbackAttempts,
			"status", resp.StatusCode,
			"err", errDetail,
			"permanent", true,
			"durationMs", duration.Milliseconds(),
		)
		d.recordFailure(ctx, j.ID, errDetail)
		return
	}

	// Retryable 5xx, 408, 429.
	slog.WarnContext(ctx, "queue.callback.retryable_error",
		"event", "queue.callback.retryable_error",
		"jobId", j.ID,
		"url", j.CallbackURL,
		"attempt", j.CallbackAttempts,
		"status", resp.StatusCode,
		"err", errDetail,
		"durationMs", duration.Milliseconds(),
	)
	d.handleRetryOrFailure(ctx, j, errDetail)
}

func (d *Dispatcher) handleRetryOrFailure(ctx context.Context, j claimedJob, errDetail string) {
	if j.CallbackAttempts < maxCallbackAttempts {
		delaySec := computeCallbackBackoffSeconds(j.CallbackAttempts)
		slog.WarnContext(ctx, "queue.callback.retry_scheduled",
			"event", "queue.callback.retry_scheduled",
			"jobId", j.ID,
			"url", j.CallbackURL,
			"attempt", j.CallbackAttempts,
			"nextRetryInSeconds", delaySec,
			"err", errDetail,
		)
		d.recordRetry(ctx, j.ID, delaySec, errDetail)
	} else {
		slog.ErrorContext(ctx, "queue.callback.failed",
			"event", "queue.callback.failed",
			"jobId", j.ID,
			"url", j.CallbackURL,
			"attempt", j.CallbackAttempts,
			"err", errDetail,
			"permanent", true,
		)
		d.recordFailure(ctx, j.ID, errDetail)
	}
}

func (d *Dispatcher) recordDelivered(ctx context.Context, jobID string) {
	if d.pool == nil {
		return
	}
	const sql = `
		UPDATE jobs
		SET callback_status = 'delivered',
		    callback_delivered_at = now(),
		    callback_last_error = NULL,
		    callback_next_retry_at = NULL
		WHERE id = $1
	`
	if _, err := d.pool.Exec(ctx, sql, jobID); err != nil {
		slog.ErrorContext(ctx, "queue.callback.record_delivered_failed", "jobId", jobID, "err", err.Error())
	}
}

func (d *Dispatcher) recordRetry(ctx context.Context, jobID string, delaySeconds int, errMsg string) {
	if d.pool == nil {
		return
	}
	const sql = `
		UPDATE jobs
		SET callback_status = 'pending',
		    callback_next_retry_at = now() + ($2 * INTERVAL '1 second'),
		    callback_last_error = $3
		WHERE id = $1
	`
	if _, err := d.pool.Exec(ctx, sql, jobID, delaySeconds, errMsg); err != nil {
		slog.ErrorContext(ctx, "queue.callback.record_retry_failed", "jobId", jobID, "err", err.Error())
	}
}

func (d *Dispatcher) recordFailure(ctx context.Context, jobID string, errMsg string) {
	if d.pool == nil {
		return
	}
	const sql = `
		UPDATE jobs
		SET callback_status = 'failed',
		    callback_last_error = $2,
		    callback_next_retry_at = NULL
		WHERE id = $1
	`
	if _, err := d.pool.Exec(ctx, sql, jobID, errMsg); err != nil {
		slog.ErrorContext(ctx, "queue.callback.record_failed_failed", "jobId", jobID, "err", err.Error())
	}
}

func computeCallbackBackoffSeconds(attempt int) int {
	switch attempt {
	case 1:
		return 5
	case 2:
		return 15
	case 3:
		return 45
	default:
		return 135
	}
}

func isNonRetryableStatus(code int) bool {
	return code >= 400 && code < 500 && code != http.StatusRequestTimeout && code != http.StatusTooManyRequests
}

func computeSignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func readBodySnippet(r io.Reader) string {
	lr := io.LimitReader(r, maxErrorSnippetBytes)
	b, err := io.ReadAll(lr)
	if err != nil {
		return ""
	}
	return string(bytes.TrimSpace(b))
}

func ctxErrString(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case err != nil:
		return err.Error()
	default:
		return "nil"
	}
}
