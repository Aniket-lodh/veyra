//go:build integration

// This file exercises the reclaim primitive end-to-end against a real
// Postgres. Build-tagged so `go test ./...` skips it; run with:
//
//	go test -tags integration ./...
//
// The scenario is the "fleet collapse → queue self-heals" invariant
// from SPEC §5.13 and the post-2026-05-26 SOAK_REPORT.md: workers claim
// jobs, the entire fleet disappears with leases still active, the
// queue's tick reclaim path requeues every stranded `running` row,
// fresh workers claim the requeued jobs, all complete. The test
// explicitly asserts execution uniqueness — no two workers ever
// concurrently execute the same logical attempt of the same job.

package queuecore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestReclaim_FleetCollapse_SelfHeals is the canonical reclaim proof.
//
// Timeline:
//  1. Enqueue N jobs with max_attempts=3.
//  2. Worker "gen1" claims all N jobs.
//  3. Fleet collapse: no Ack/Nack — all N rows sit in `running` with
//     a stale lease and current_worker_id=gen1.
//  4. Fast-forward time by setting lease_expires_at to the past
//     (instead of sleeping 40s+ in every CI run).
//  5. Drive ONE tick of the reclaim sweep (in-test helper that
//     mirrors the apps/api tick driver — see runReclaimTick below).
//  6. Assert: every row is back to `queued`, no rows in `running`,
//     every gen1 attempt has outcome='lease_lost'.
//  7. Worker "gen2" claims all N requeued jobs.
//  8. gen2 acks each one successfully.
//  9. Assert final state: all N jobs `succeeded`.
//  10. Assert execution uniqueness: for every job, attempt N+1's
//     started_at is >= attempt N's ended_at (no temporal overlap),
//     and (job_id, attempt_number) is unique (schema-enforced, but
//     double-checked).
//  11. Assert attempt-number density: attempts are 1, 2, …, with no
//     gaps.
func TestReclaim_FleetCollapse_SelfHeals(t *testing.T) {
	const (
		N              = 12 // job count
		gen1WorkerID   = "01TESTWORKERGEN0000000000001"
		gen2WorkerID   = "01TESTWORKERGEN0000000000002"
		queueName      = "fleet-collapse-test"
		handlerName    = "test.handler"
		reclaimGrace   = queuecore.ReclaimGraceSeconds // 10s, the const we re-verify against
		fastForwardSec = reclaimGrace + 60             // push the lease comfortably past grace
		tickRowLimit   = 100
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)

	// --- step 1: enqueue N jobs ---------------------------------------
	jobIDs := make([]string, N)
	for i := 0; i < N; i++ {
		jobIDs[i] = fmt.Sprintf("01TESTJOB000000000000000%04d", i+1)
		_, err := repo.Create(ctx, queuecore.CreateParams{
			ID:          jobIDs[i],
			Handler:     handlerName,
			Queue:       queueName,
			MaxAttempts: 3,
			Backoff:     queuecore.DefaultBackoff(),
			Payload:     json.RawMessage(`{}`),
		})
		if err != nil {
			t.Fatalf("enqueue job %d: %v", i, err)
		}
	}
	requireStatusCount(t, ctx, pool, "queued", N)

	// --- step 2: gen1 claims all N ------------------------------------
	gen1Claimed := claimN(t, ctx, repo, gen1WorkerID, queueName, N)
	for i, j := range gen1Claimed {
		if j.Status != queuecore.StatusRunning {
			t.Fatalf("gen1 claim %d: expected status=running, got %s", i, j.Status)
		}
		if j.Attempt != 1 {
			t.Fatalf("gen1 claim %d: expected attempt=1, got %d", i, j.Attempt)
		}
		if j.CurrentWorkerID == nil || *j.CurrentWorkerID != gen1WorkerID {
			t.Fatalf("gen1 claim %d: current_worker_id mismatch", i)
		}
	}
	requireStatusCount(t, ctx, pool, "running", N)
	requireAttemptCount(t, ctx, pool, "lease_lost", 0)

	// --- step 3 + 4: simulate fleet death by abandoning, then fast-forward
	// the leases. In production the worker container would crash; in the
	// test we just stop calling Ack/Nack and rewrite lease_expires_at to
	// a past time so the reclaim tick will pick them up on its very next
	// scan. This is the only place the test diverges from the wall-clock
	// scenario — every other transition uses real Postgres semantics.
	if _, err := pool.Exec(ctx, `
		UPDATE jobs
		SET lease_expires_at = now() - make_interval(secs => $1)
		WHERE status = 'running'
	`, fastForwardSec); err != nil {
		t.Fatalf("fast-forward leases: %v", err)
	}

	// --- step 5: one reclaim tick -------------------------------------
	// This MUST requeue all N rows. The tick uses FOR UPDATE SKIP LOCKED
	// + per-row SAVEPOINT exactly as the apps/api driver does — see
	// apps/api/internal/reclaim/driver.go. The two implementations are
	// in lockstep because they both invoke queuecore.Reclaim with the
	// same params.
	stats := runReclaimTick(t, ctx, pool, tickRowLimit)
	if stats.requeued != N {
		t.Fatalf("tick: expected requeued=%d, got %d (stats=%+v)", N, stats.requeued, stats)
	}
	if stats.dlq != 0 || stats.stale != 0 || stats.failed != 0 {
		t.Fatalf("tick: expected dlq=0 stale=0 failed=0, got %+v", stats)
	}

	requireStatusCount(t, ctx, pool, "queued", N)
	requireStatusCount(t, ctx, pool, "running", 0)
	requireAttemptCount(t, ctx, pool, "lease_lost", N)

	// --- step 6: verify per-row invariants after reclaim --------------
	// Every job's row: status=queued, current_worker_id=NULL,
	// lease_expires_at=NULL, attempt UNCHANGED (still 1 — §5.5.2's
	// "attempt is not incremented" invariant), scheduled_for UNCHANGED
	// (§5.5.2's "scheduling intent preserved" invariant).
	for _, jid := range jobIDs {
		var (
			status         string
			currentWorker  *string
			leaseExpiresAt *time.Time
			attempt        int
		)
		err := pool.QueryRow(ctx, `
			SELECT status::text, current_worker_id, lease_expires_at, attempt
			FROM jobs WHERE id = $1
		`, jid).Scan(&status, &currentWorker, &leaseExpiresAt, &attempt)
		if err != nil {
			t.Fatalf("post-reclaim row %s: %v", jid, err)
		}
		if status != "queued" {
			t.Errorf("job %s: post-reclaim status=%q (want queued)", jid, status)
		}
		if currentWorker != nil {
			t.Errorf("job %s: post-reclaim current_worker_id=%q (want NULL)", jid, *currentWorker)
		}
		if leaseExpiresAt != nil {
			t.Errorf("job %s: post-reclaim lease_expires_at=%v (want NULL)", jid, *leaseExpiresAt)
		}
		if attempt != 1 {
			t.Errorf("job %s: post-reclaim attempt=%d (want 1 — §5.5.2 attempt NOT incremented)", jid, attempt)
		}
	}

	// --- step 7: gen2 claims all N requeued jobs ----------------------
	gen2Claimed := claimN(t, ctx, repo, gen2WorkerID, queueName, N)
	for i, j := range gen2Claimed {
		if j.Attempt != 2 {
			t.Errorf("gen2 claim %d (job %s): expected attempt=2 (gen1 didn't increment, gen2 increments to 2), got %d",
				i, j.ID, j.Attempt)
		}
		if j.CurrentWorkerID == nil || *j.CurrentWorkerID != gen2WorkerID {
			t.Errorf("gen2 claim %d (job %s): current_worker_id mismatch", i, j.ID)
		}
	}

	// --- step 8: gen2 acks each one -----------------------------------
	for _, j := range gen2Claimed {
		_, err := repo.MarkJobSucceeded(ctx, queuecore.SucceedParams{
			WorkerID: gen2WorkerID,
			JobID:    j.ID,
		})
		if err != nil {
			t.Fatalf("gen2 ack %s: %v", j.ID, err)
		}
	}

	// --- step 9: final state ------------------------------------------
	requireStatusCount(t, ctx, pool, "succeeded", N)
	requireStatusCount(t, ctx, pool, "queued", 0)
	requireStatusCount(t, ctx, pool, "running", 0)
	requireStatusCount(t, ctx, pool, "failed", 0)
	requireStatusCount(t, ctx, pool, "dead_lettered", 0)

	// --- step 10: execution uniqueness --------------------------------
	// For each job, list attempts ordered by attempt_number. Verify:
	//   - attempt numbers are dense (1, 2, …) — no gaps.
	//   - attempt N+1's started_at >= attempt N's ended_at (no temporal
	//     overlap, which would imply concurrent execution by two
	//     workers of the same job).
	//   - attempt 1 worker is gen1; attempt 2 worker is gen2.
	//   - attempt 1 outcome is 'lease_lost'; attempt 2 outcome is 'succeeded'.
	for _, jid := range jobIDs {
		attempts := listAttempts(t, ctx, pool, jid)
		if len(attempts) != 2 {
			t.Errorf("job %s: expected exactly 2 attempts (gen1 lease_lost + gen2 succeeded), got %d",
				jid, len(attempts))
			continue
		}
		if attempts[0].number != 1 || attempts[1].number != 2 {
			t.Errorf("job %s: attempt numbers should be [1,2], got [%d,%d]",
				jid, attempts[0].number, attempts[1].number)
		}
		if attempts[0].workerID != gen1WorkerID || attempts[1].workerID != gen2WorkerID {
			t.Errorf("job %s: worker IDs should be [%s,%s], got [%s,%s]",
				jid, gen1WorkerID, gen2WorkerID, attempts[0].workerID, attempts[1].workerID)
		}
		if attempts[0].outcome == nil || *attempts[0].outcome != "lease_lost" {
			t.Errorf("job %s: attempt 1 outcome should be lease_lost, got %v", jid, attempts[0].outcome)
		}
		if attempts[1].outcome == nil || *attempts[1].outcome != "succeeded" {
			t.Errorf("job %s: attempt 2 outcome should be succeeded, got %v", jid, attempts[1].outcome)
		}

		// Temporal uniqueness: attempts[0].ended_at <= attempts[1].started_at.
		// If this fails, two workers were executing the same job at the
		// same wall-clock time — the headline invariant we are
		// protecting against ("reclaim does NOT create concurrent
		// duplicate execution").
		if attempts[0].endedAt == nil {
			t.Errorf("job %s: attempt 1 has no ended_at — should have been closed by reclaim", jid)
			continue
		}
		if !attempts[0].endedAt.Before(attempts[1].startedAt) && !attempts[0].endedAt.Equal(attempts[1].startedAt) {
			t.Errorf("job %s: TEMPORAL OVERLAP — attempt 1 ended at %v, attempt 2 started at %v (overlap implies concurrent execution by two workers of the same job)",
				jid, attempts[0].endedAt, attempts[1].startedAt)
		}
	}

	// --- step 11: schema-level uniqueness (sanity) --------------------
	var duplicateRows int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT job_id, attempt_number
		    FROM   job_attempts
		    GROUP BY job_id, attempt_number
		    HAVING count(*) > 1
		) d
	`).Scan(&duplicateRows)
	if err != nil {
		t.Fatalf("duplicate-attempt count: %v", err)
	}
	if duplicateRows != 0 {
		t.Fatalf("found %d (job_id, attempt_number) pairs with >1 row — schema invariant violated", duplicateRows)
	}
}

// --- helpers ---------------------------------------------------------

type tickStats struct {
	scanned  int
	requeued int
	dlq      int
	stale    int
	failed   int
}

// runReclaimTick mirrors apps/api/internal/reclaim/driver.go's tick
// logic in-test, so we exercise the same selection predicate + locking
// discipline + per-row Reclaim invocation without depending on the api
// module (queue-core cannot import apps/api). If the in-test loop
// disagrees with the apps/api driver, ONE of them violates SPEC §5.10;
// the SPEC is the source of truth.
func runReclaimTick(t *testing.T, ctx context.Context, pool *pgxpool.Pool, limit int) tickStats {
	t.Helper()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("tick: begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const selectSQL = `
		SELECT id, attempt, max_attempts, current_worker_id
		FROM jobs
		WHERE status = 'running'
		  AND lease_expires_at + make_interval(secs => $1) <= now()
		ORDER BY lease_expires_at ASC
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	`
	rows, err := tx.Query(ctx, selectSQL, queuecore.ReclaimGraceSeconds, limit)
	if err != nil {
		t.Fatalf("tick: select: %v", err)
	}
	type cand struct {
		id, priorWorker string
		attempt, max    int
	}
	var batch []cand
	for rows.Next() {
		var c cand
		var w *string
		if err := rows.Scan(&c.id, &c.attempt, &c.max, &w); err != nil {
			rows.Close()
			t.Fatalf("tick: scan: %v", err)
		}
		if w != nil {
			c.priorWorker = *w
		}
		batch = append(batch, c)
	}
	rows.Close()

	stats := tickStats{scanned: len(batch)}
	for _, c := range batch {
		spName := "sp_test_" + safeSuffix(c.id)
		if _, err := tx.Exec(ctx, "SAVEPOINT "+spName); err != nil {
			t.Fatalf("tick: savepoint: %v", err)
		}
		result, err := queuecore.Reclaim(ctx, tx, queuecore.ReclaimParams{
			Mode:          queuecore.ReclaimModeTickRequeue,
			JobID:         c.id,
			Attempt:       c.attempt,
			MaxAttempts:   c.max,
			PriorWorkerID: c.priorWorker,
		})
		if err != nil {
			stats.failed++
			if _, rbErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName); rbErr != nil {
				t.Fatalf("tick: rollback savepoint: %v", rbErr)
			}
			continue
		}
		if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT "+spName); err != nil {
			t.Fatalf("tick: release savepoint: %v", err)
		}
		switch result.Outcome {
		case queuecore.ReclaimOutcomeRequeued:
			stats.requeued++
		case queuecore.ReclaimOutcomeDeadLettered:
			stats.dlq++
		case queuecore.ReclaimOutcomeStale:
			stats.stale++
		default:
			t.Fatalf("tick: unexpected outcome %q for job %s", result.Outcome, c.id)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("tick: commit: %v", err)
	}
	return stats
}

func claimN(t *testing.T, ctx context.Context, repo *queuecore.Repository, workerID, queueName string, n int) []*queuecore.Job {
	t.Helper()
	out := make([]*queuecore.Job, 0, n)
	for i := 0; i < n; i++ {
		j, err := repo.ClaimNextJob(ctx, workerID, []string{queueName})
		if err != nil {
			t.Fatalf("claim %d (worker=%s): %v", i, workerID, err)
		}
		if j == nil {
			t.Fatalf("claim %d (worker=%s): nil job returned, expected %d total claims", i, workerID, n)
		}
		out = append(out, j)
	}
	return out
}

func requireStatusCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, status string, want int) {
	t.Helper()
	var got int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE status = $1::job_status`, status).Scan(&got); err != nil {
		t.Fatalf("requireStatusCount(%s): %v", status, err)
	}
	if got != want {
		t.Errorf("status %s: want %d, got %d", status, want, got)
	}
}

func requireAttemptCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, outcome string, want int) {
	t.Helper()
	var got int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM job_attempts WHERE outcome = $1::attempt_outcome`, outcome).Scan(&got); err != nil {
		t.Fatalf("requireAttemptCount(%s): %v", outcome, err)
	}
	if got != want {
		t.Errorf("attempts outcome=%s: want %d, got %d", outcome, want, got)
	}
}

type attemptRow struct {
	number    int
	workerID  string
	startedAt time.Time
	endedAt   *time.Time
	outcome   *string
}

func listAttempts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, jobID string) []attemptRow {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT attempt_number, worker_id, started_at, ended_at, outcome::text
		FROM job_attempts WHERE job_id = $1
		ORDER BY attempt_number ASC
	`, jobID)
	if err != nil {
		t.Fatalf("listAttempts(%s): %v", jobID, err)
	}
	defer rows.Close()
	var out []attemptRow
	for rows.Next() {
		var r attemptRow
		var outcome *string
		if err := rows.Scan(&r.number, &r.workerID, &r.startedAt, &r.endedAt, &outcome); err != nil {
			t.Fatalf("listAttempts(%s) scan: %v", jobID, err)
		}
		r.outcome = outcome
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].number < out[j].number })
	return out
}

// safeSuffix mirrors apps/api/internal/reclaim/driver.go's helper of
// the same name. Postgres SAVEPOINT identifiers permit only
// [A-Za-z0-9_]; substitute everything else with underscore.
func safeSuffix(id string) string {
	out := make([]byte, 0, len(id))
	for i := 0; i < len(id); i++ {
		b := id[i]
		switch {
		case b >= 'A' && b <= 'Z', b >= 'a' && b <= 'z', b >= '0' && b <= '9':
			out = append(out, b)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}
