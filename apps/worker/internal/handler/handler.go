// Package handler is the worker's job-execution seam. The runtime dequeues a
// job, looks the job's handler name up in a Registry, and calls Handle. This
// is the boundary between queue coordination (runtime, queue-core) and the
// actual work a job represents (sleep, HTTP request, …).
//
// The registry is intentionally minimal: a static name→Handler map built once
// in main.go before Run starts. No dynamic registration, no plugins, no
// dynamic loading, no reflection. Adding a handler is a plain map insert.
package handler

import (
	"context"
	"encoding/json"
	"sort"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler executes one job. Implementations MUST be idempotent — a job may run
// more than once across lease expiry, reclaim, and retry (see apps/worker
// CLAUDE.md) — and MUST respect ctx cancellation: when ctx is done, return
// promptly with ctx.Err() and do not assume the result will be recorded, since
// the lease may have been lost to a reclaiming worker.
type Handler interface {
	// Handle runs the job. On success it returns the result payload to store
	// verbatim in jobs.result (may be nil). On failure it returns a non-nil
	// error; return a *handler.Error to control the recorded error class.
	Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error)
}

// Error is a structured handler failure. Class is recorded verbatim as
// jobs.error.class so the operator UI can group failures (e.g. "http_5xx",
// "timeout", "UnknownHandler") without log diving. Plain (non-*Error) errors
// returned by a handler are recorded under a generic class by the runtime.
//
// Permanent (default false) tells Nack to dead-letter immediately regardless
// of remaining attempt budget — SPEC.md §7. Zero value preserves today's
// retryable behavior for every existing construction site.
type Error struct {
	Class     string
	Message   string
	Permanent bool
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Class
	}
	return e.Class + ": " + e.Message
}

// Registry is a static name→Handler map. Build it once at boot via NewRegistry
// + Register, then hand it to the runtime; it is read-only thereafter. Lookup
// is on the dequeue→dispatch hot path.
type Registry struct {
	handlers map[string]Handler
}

// NewRegistry returns an empty registry ready for Register calls.
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

// Register adds (or replaces) the handler for name. Call only during boot,
// before the runtime starts dispatching.
func (r *Registry) Register(name string, h Handler) {
	r.handlers[name] = h
}

// Lookup returns the handler registered for name, or ok=false if none is.
func (r *Registry) Lookup(name string) (Handler, bool) {
	h, ok := r.handlers[name]
	return h, ok
}

// Names returns the registered handler names, sorted. This is what the worker
// advertises in workers.handlers[] — observability only; the dequeue path
// never reads that column (queue-core SPEC §1.2). Sorted output keeps the
// advertised set and logs stable across boots.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.handlers))
	for n := range r.handlers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
