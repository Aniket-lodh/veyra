// Package handler is the worker's job-execution seam.
package handler

import (
	"context"
	"encoding/json"
	"sort"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

// Handler executes one job.
type Handler interface {
	// Handle runs the job.
	Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error)
}

// Error is a structured handler failure.
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

// Registry is a static name→Handler map.
type Registry struct {
	handlers map[string]Handler
}

// NewRegistry returns an empty registry ready for Register calls.
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

// Register adds (or replaces) the handler for name.
func (r *Registry) Register(name string, h Handler) {
	r.handlers[name] = h
}

// Lookup returns the handler registered for name, or ok=false if none is.
func (r *Registry) Lookup(name string) (Handler, bool) {
	h, ok := r.handlers[name]
	return h, ok
}

// Names returns the registered handler names, sorted.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.handlers))
	for n := range r.handlers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
