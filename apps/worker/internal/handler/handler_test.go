package handler

import (
	"context"
	"errors"
	"testing"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

func TestRegistry_LookupAndNames(t *testing.T) {
	r := NewRegistry()
	if _, ok := r.Lookup("noop"); ok {
		t.Fatal("empty registry should not resolve any handler")
	}

	noop := NewNoop(0, 0)
	r.Register("noop", noop)
	r.Register("http_request", noop) // any Handler; we only assert registration here

	got, ok := r.Lookup("noop")
	if !ok || got != noop {
		t.Fatalf("Lookup(noop) = %v, %v; want the registered handler, true", got, ok)
	}

	// Names is sorted and reflects exactly what was registered.
	names := r.Names()
	want := []string{"http_request", "noop"}
	if len(names) != len(want) {
		t.Fatalf("Names() = %v; want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("Names() = %v; want %v", names, want)
		}
	}
}

func TestNoop_Succeeds(t *testing.T) {
	n := NewNoop(0, 0) // no sleep, never fail
	result, err := n.Handle(context.Background(), &queuecore.Job{ID: "j1", Handler: "noop"})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	if len(result) == 0 {
		t.Fatal("Handle returned empty result; want a JSON payload")
	}
}

func TestNoop_AlwaysFails_CarriesClass(t *testing.T) {
	n := NewNoop(0, 100) // always fail
	_, err := n.Handle(context.Background(), &queuecore.Job{ID: "j1", Handler: "noop"})
	if err == nil {
		t.Fatal("Handle with 100% failure returned nil error")
	}
	var herr *Error
	if !errors.As(err, &herr) {
		t.Fatalf("error %v is not a *handler.Error", err)
	}
	if herr.Class != "SimulatedFailure" {
		t.Fatalf("error class = %q; want SimulatedFailure", herr.Class)
	}
}

func TestNoop_RespectsCancellation(t *testing.T) {
	n := NewNoop(time.Hour, 0) // would sleep an hour if not cancelled
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := n.Handle(ctx, &queuecore.Job{ID: "j1", Handler: "noop"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Handle on cancelled ctx returned %v; want context.Canceled", err)
	}
}

func TestNoop_FailurePercentClamped(t *testing.T) {
	// Out-of-range percents clamp rather than panicking or skewing rand.
	if NewNoop(0, -5).failurePercent != 0 {
		t.Fatal("negative failurePercent should clamp to 0")
	}
	if NewNoop(0, 250).failurePercent != 100 {
		t.Fatal("failurePercent > 100 should clamp to 100")
	}
}
