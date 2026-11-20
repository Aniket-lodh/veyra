package runtime

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrencySemaphore_BoundedPool(t *testing.T) {
	t.Parallel()

	const maxConcurrency = 3
	sem := make(chan struct{}, maxConcurrency)

	// Acquire up to maxConcurrency slots
	for i := 0; i < maxConcurrency; i++ {
		select {
		case sem <- struct{}{}:
		default:
			t.Fatalf("expected slot %d to be available", i)
		}
	}

	// 4th slot should block
	select {
	case sem <- struct{}{}:
		t.Fatal("expected slot 4 to block because concurrency is full")
	default:
		// expected
	}

	// Release 1 slot
	<-sem

	// Now 1 slot should be acquirable again
	select {
	case sem <- struct{}{}:
	default:
		t.Fatal("expected 1 slot to be acquirable after releasing")
	}
}

func TestConcurrentJobExecution_Draining(t *testing.T) {
	t.Parallel()

	const maxConcurrency = 3
	sem := make(chan struct{}, maxConcurrency)
	var jobsWg sync.WaitGroup

	lifetimeCtx, lifetimeCancel := context.WithCancel(context.Background())
	defer lifetimeCancel()

	var runningCount int32
	var maxConcurrentObserved int32
	var completedCount int32

	runJob := func() {
		jobsWg.Add(1)
		go func() {
			defer func() {
				atomic.AddInt32(&runningCount, -1)
				<-sem
				jobsWg.Done()
			}()

			cur := atomic.AddInt32(&runningCount, 1)
			for {
				old := atomic.LoadInt32(&maxConcurrentObserved)
				if cur <= old || atomic.CompareAndSwapInt32(&maxConcurrentObserved, old, cur) {
					break
				}
			}

			// Simulate job execution work respecting lifetimeCtx
			select {
			case <-time.After(50 * time.Millisecond):
				atomic.AddInt32(&completedCount, 1)
			case <-lifetimeCtx.Done():
				// Cancelled during shutdown
			}
		}()
	}

	// Launch 5 jobs through semaphore
	for i := 0; i < 5; i++ {
		sem <- struct{}{}
		runJob()
	}

	// Wait for all 5 jobs to drain cleanly
	drainDone := make(chan struct{})
	go func() {
		jobsWg.Wait()
		close(drainDone)
	}()

	select {
	case <-drainDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for jobs to drain")
	}

	if atomic.LoadInt32(&completedCount) != 5 {
		t.Fatalf("expected all 5 jobs to complete, got %d", completedCount)
	}
	if atomic.LoadInt32(&maxConcurrentObserved) > maxConcurrency {
		t.Fatalf("max concurrent jobs observed %d exceeded limit %d", maxConcurrentObserved, maxConcurrency)
	}
	if len(sem) != 0 {
		t.Fatalf("expected semaphore to be empty (all slots returned), got %d held", len(sem))
	}
}

func TestConcurrentJobExecution_ShutdownDrainTimeout(t *testing.T) {
	t.Parallel()

	const maxConcurrency = 2
	sem := make(chan struct{}, maxConcurrency)
	var jobsWg sync.WaitGroup

	lifetimeCtx, lifetimeCancel := context.WithCancel(context.Background())

	var interruptedCount int32

	// Launch a job that hangs until lifetimeCtx is cancelled
	sem <- struct{}{}
	jobsWg.Add(1)
	go func() {
		defer func() {
			<-sem
			jobsWg.Done()
		}()
		<-lifetimeCtx.Done()
		atomic.AddInt32(&interruptedCount, 1)
	}()

	drainDone := make(chan struct{})
	go func() {
		jobsWg.Wait()
		close(drainDone)
	}()

	// Simulate shutdown timeout expiring and triggering lifetimeCancel()
	select {
	case <-drainDone:
		t.Fatal("expected drain to wait for running job")
	case <-time.After(20 * time.Millisecond):
		lifetimeCancel() // simulate drain timeout cancellation
	}

	select {
	case <-drainDone:
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for cancelled job to exit")
	}

	if atomic.LoadInt32(&interruptedCount) != 1 {
		t.Fatalf("expected 1 job interrupted, got %d", interruptedCount)
	}
}
