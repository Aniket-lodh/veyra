//go:build integration

package queuecore_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
	"github.com/Aniket-lodh/veyra/queue-core/testsupport"
)

// TestClaim_EnforcesWorkerLifecycle covers SPEC §1.2 & §4.11:
// Workers in draining, cordoned, or disconnected states cannot claim new jobs.
func TestClaim_EnforcesWorkerLifecycle(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const queueName = "worker-lifecycle-queue"
	const handlerName = "test.worker.lifecycle.handler"
	const workerID = "01TESTLIFECYCLEWORKER00000001"

	// Register worker as active
	_, err := pool.Exec(ctx, `
		INSERT INTO workers (id, hostname, pid, version, state, queues, handlers, max_concurrency)
		VALUES ($1, 'worker-host-1', 101, '1.0.0', 'active', $2, $3, 5)
	`, workerID, []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("insert worker: %v", err)
	}

	secs := 2
	_, err = repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTLIFECYCLEJOB0000000001",
		Handler:     handlerName,
		Queue:       queueName,
		MaxAttempts: 3,
		Backoff:     queuecore.BackoffStrategy{Kind: "fixed", Seconds: &secs},
		Payload:     json.RawMessage(`{"lifecycle":true}`),
	})
	if err != nil {
		t.Fatalf("Create job: %v", err)
	}

	// 1. Cordon worker -> ClaimNextJob should return (nil, nil)
	_, err = pool.Exec(ctx, "UPDATE workers SET state = 'cordoned' WHERE id = $1", workerID)
	if err != nil {
		t.Fatalf("update worker to cordoned: %v", err)
	}

	job, err := repo.ClaimNextJob(ctx, workerID, []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob cordoned worker: %v", err)
	}
	if job != nil {
		t.Fatalf("expected nil job for cordoned worker, got %v", job)
	}

	// 2. Drain worker -> ClaimNextJob should return (nil, nil)
	_, err = pool.Exec(ctx, "UPDATE workers SET state = 'draining' WHERE id = $1", workerID)
	if err != nil {
		t.Fatalf("update worker to draining: %v", err)
	}

	job, err = repo.ClaimNextJob(ctx, workerID, []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob draining worker: %v", err)
	}
	if job != nil {
		t.Fatalf("expected nil job for draining worker, got %v", job)
	}

	// 3. Disconnected worker -> ClaimNextJob should return (nil, nil)
	_, err = pool.Exec(ctx, "UPDATE workers SET state = 'disconnected' WHERE id = $1", workerID)
	if err != nil {
		t.Fatalf("update worker to disconnected: %v", err)
	}

	job, err = repo.ClaimNextJob(ctx, workerID, []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob disconnected worker: %v", err)
	}
	if job != nil {
		t.Fatalf("expected nil job for disconnected worker, got %v", job)
	}

	// 4. Resume worker to active -> ClaimNextJob should succeed!
	_, err = pool.Exec(ctx, "UPDATE workers SET state = 'active' WHERE id = $1", workerID)
	if err != nil {
		t.Fatalf("update worker to active: %v", err)
	}

	job, err = repo.ClaimNextJob(ctx, workerID, []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob active worker: %v", err)
	}
	if job == nil || job.ID != "01TESTLIFECYCLEJOB0000000001" {
		t.Fatalf("expected job 01TESTLIFECYCLEJOB0000000001, got %v", job)
	}
}
