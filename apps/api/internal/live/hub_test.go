package live

import (
	"testing"
	"time"
)

func TestHub_CoalescesBurst(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe()
	defer sub.Unsubscribe()

	h.MarkDirty(ResourceJobs)
	h.MarkDirty(ResourceJobs, ResourceStats)
	h.MarkDirty(ResourceWorkers)

	ev, ok := waitEvent(t, sub, coalesceWindow+200*time.Millisecond)
	if !ok {
		t.Fatal("expected coalesced event")
	}
	if ev.Revision != 1 {
		t.Fatalf("revision=%d want 1", ev.Revision)
	}
	want := map[string]bool{ResourceJobs: true, ResourceStats: true, ResourceWorkers: true}
	if len(ev.Resources) != 3 {
		t.Fatalf("resources=%v want 3", ev.Resources)
	}
	for _, r := range ev.Resources {
		if !want[r] {
			t.Fatalf("unexpected resource %q in %v", r, ev.Resources)
		}
	}

	select {
	case extra := <-sub.C():
		t.Fatalf("unexpected second event: %+v", extra)
	case <-time.After(coalesceWindow + 50*time.Millisecond):
	}
}

func TestHub_PublishNotifyJobsImpliesStats(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe()
	defer sub.Unsubscribe()

	h.PublishNotify(ResourceJobs)
	ev, ok := waitEvent(t, sub, coalesceWindow+200*time.Millisecond)
	if !ok {
		t.Fatal("timeout")
	}
	if len(ev.Resources) != 2 {
		t.Fatalf("resources=%v", ev.Resources)
	}
}

func TestHub_RevisionMonotonic(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe()
	defer sub.Unsubscribe()

	h.MarkDirty(ResourceJobs)
	ev1, _ := waitEvent(t, sub, coalesceWindow+200*time.Millisecond)
	h.MarkDirty(ResourceWorkers)
	ev2, _ := waitEvent(t, sub, coalesceWindow+200*time.Millisecond)
	if ev2.Revision <= ev1.Revision {
		t.Fatalf("revisions not monotonic: %d then %d", ev1.Revision, ev2.Revision)
	}
}

func TestHub_ResyncBumpsRevision(t *testing.T) {
	h := NewHub()
	before := h.Revision()
	ev := h.ResyncEvent()
	if ev.Revision != before+1 {
		t.Fatalf("resync revision=%d want %d", ev.Revision, before+1)
	}
	if len(ev.Resources) != 3 {
		t.Fatalf("resync resources=%v", ev.Resources)
	}
}

func TestHub_SlowSubscriberLatestWins(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe()
	defer sub.Unsubscribe()

	// Fill buffer without reading.
	h.MarkDirty(ResourceJobs)
	time.Sleep(coalesceWindow + 30*time.Millisecond)
	h.MarkDirty(ResourceWorkers)
	time.Sleep(coalesceWindow + 30*time.Millisecond)
	h.MarkDirty(ResourceStats)
	time.Sleep(coalesceWindow + 50*time.Millisecond)

	// Drain: should not see more than 2 frames (one buffered + pending/latest).
	var last Event
	count := 0
	deadline := time.After(300 * time.Millisecond)
	for {
		if ev, ok := sub.TakePending(); ok {
			last = ev
			count++
			continue
		}
		select {
		case ev, ok := <-sub.C():
			if !ok {
				t.Fatal("closed")
			}
			last = ev
			count++
			if count > 3 {
				t.Fatalf("too many frames (%d); coalescing failed", count)
			}
		case <-deadline:
			if count == 0 {
				t.Fatal("no events")
			}
			// Latest must include stats (last MarkDirty).
			found := false
			for _, r := range last.Resources {
				if r == ResourceStats {
					found = true
				}
			}
			if !found && count == 1 {
				// Only first jobs frame was kept — pending should have latest.
				t.Fatalf("last event missing stats: %+v (count=%d)", last, count)
			}
			return
		}
	}
}

func waitEvent(t *testing.T, sub *Subscription, timeout time.Duration) (Event, bool) {
	t.Helper()
	select {
	case ev, ok := <-sub.C():
		return ev, ok
	case <-time.After(timeout):
		return Event{}, false
	}
}
