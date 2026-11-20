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

func TestQueuePause_ClaimSkippingAndResume(t *testing.T) {
	pool := testsupport.StartPostgres(t)
	repo := queuecore.NewRepository(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const queueName = "pause-test-queue"
	const handlerName = "test.pause.handler"

	secs := 2
	_, err := repo.Create(ctx, queuecore.CreateParams{
		ID:          "01TESTPAUSEJOB00000000001",
		Handler:     handlerName,
		Queue:       queueName,
		MaxAttempts: 3,
		Backoff:     queuecore.BackoffStrategy{Kind: "fixed", Seconds: &secs},
		Payload:     json.RawMessage(`{"hello":"world"}`),
	})
	if err != nil {
		t.Fatalf("Create job: %v", err)
	}

	// 1. Pause the queue
	qs, err := repo.PauseQueue(ctx, queuecore.PauseQueueParams{
		QueueName: queueName,
		Reason:    "Maintenance window",
	})
	if err != nil {
		t.Fatalf("PauseQueue: %v", err)
	}
	if !qs.Paused || qs.PausedReason == nil || *qs.PausedReason != "Maintenance window" {
		t.Fatalf("unexpected paused state: %+v", qs)
	}
	initialPausedAt := *qs.PausedAt

	// 1b. Re-pause without reason -> preserves reason and pausedAt
	qsRePauseNoReason, err := repo.PauseQueue(ctx, queuecore.PauseQueueParams{
		QueueName: queueName,
	})
	if err != nil {
		t.Fatalf("Re-pause without reason: %v", err)
	}
	if !qsRePauseNoReason.Paused || qsRePauseNoReason.PausedReason == nil || *qsRePauseNoReason.PausedReason != "Maintenance window" {
		t.Fatalf("re-pause without reason did not preserve reason: %+v", qsRePauseNoReason)
	}
	if !qsRePauseNoReason.PausedAt.Equal(initialPausedAt) {
		t.Fatalf("re-pause without reason did not preserve initial paused_at")
	}

	// 1c. Re-pause with new reason -> updates reason and preserves pausedAt
	qsRePauseNewReason, err := repo.PauseQueue(ctx, queuecore.PauseQueueParams{
		QueueName: queueName,
		Reason:    "Extended maintenance window",
	})
	if err != nil {
		t.Fatalf("Re-pause with new reason: %v", err)
	}
	if !qsRePauseNewReason.Paused || qsRePauseNewReason.PausedReason == nil || *qsRePauseNewReason.PausedReason != "Extended maintenance window" {
		t.Fatalf("re-pause with new reason did not update reason: %+v", qsRePauseNewReason)
	}
	if !qsRePauseNewReason.PausedAt.Equal(initialPausedAt) {
		t.Fatalf("re-pause with new reason did not preserve initial paused_at")
	}

	// 2. QueueStats should reflect paused state
	stats, err := repo.QueueStats(ctx)
	if err != nil {
		t.Fatalf("QueueStats: %v", err)
	}
	var foundQueue *queuecore.QueueAggregate
	for _, q := range stats.PerQueue {
		if q.Name == queueName {
			foundQueue = &q
			break
		}
	}
	if foundQueue == nil {
		t.Fatalf("queue %s not found in stats", queueName)
	}
	if !foundQueue.Paused || foundQueue.PausedReason == nil || *foundQueue.PausedReason != "Extended maintenance window" {
		t.Fatalf("stats did not reflect paused state: %+v", foundQueue)
	}

	// 3. Worker attempting to claim should get nil (skipped)
	claimed, err := repo.ClaimNextJob(ctx, "01TESTWORKER0000000000001", []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob on paused queue returned error: %v", err)
	}
	if claimed != nil {
		t.Fatalf("expected nil claim from paused queue, got job %s", claimed.ID)
	}

	// 4. Resume the queue
	resumed, err := repo.ResumeQueue(ctx, queuecore.ResumeQueueParams{
		QueueName: queueName,
	})
	if err != nil {
		t.Fatalf("ResumeQueue: %v", err)
	}
	if resumed.Paused || resumed.PausedAt != nil || resumed.PausedReason != nil {
		t.Fatalf("unexpected resumed state: %+v", resumed)
	}

	// 5. Worker claiming now should successfully receive the job
	claimedAfterResume, err := repo.ClaimNextJob(ctx, "01TESTWORKER0000000000001", []string{queueName}, []string{handlerName})
	if err != nil {
		t.Fatalf("ClaimNextJob after resume: %v", err)
	}
	if claimedAfterResume == nil || claimedAfterResume.ID != "01TESTPAUSEJOB00000000001" {
		t.Fatalf("expected job 01TESTPAUSEJOB00000000001, got: %+v", claimedAfterResume)
	}
}
