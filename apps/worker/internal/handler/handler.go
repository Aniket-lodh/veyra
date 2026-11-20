package handler

import (
	"context"
	"encoding/json"
	"sort"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type Handler interface {
	Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error)
}

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

type Registry struct {
	handlers map[string]Handler
}

func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

func (r *Registry) Register(name string, h Handler) {
	r.handlers[name] = h
}

func (r *Registry) Lookup(name string) (Handler, bool) {
	h, ok := r.handlers[name]
	return h, ok
}

func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.handlers))
	for n := range r.handlers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
