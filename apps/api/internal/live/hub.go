package live

import (
	"sort"
	"sync"
	"time"
)

const (
	ResourceJobs    = "jobs"
	ResourceWorkers = "workers"
	ResourceStats   = "stats"

	coalesceWindow = 75 * time.Millisecond
)

var AllResources = []string{ResourceJobs, ResourceWorkers, ResourceStats}

type Event struct {
	V         int       `json:"v"`
	Revision  uint64    `json:"revision"`
	Resources []string  `json:"resources"`
	At        time.Time `json:"at"`
}

type Subscription struct {
	hub *Hub
	ch  chan Event
}

func (s *Subscription) C() <-chan Event { return s.ch }

func (s *Subscription) TakePending() (Event, bool) {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	st, ok := s.hub.subs[s]
	if !ok || st.pending == nil {
		return Event{}, false
	}
	ev := *st.pending
	st.pending = nil
	return ev, true
}

func (s *Subscription) Unsubscribe() {
	s.hub.unsubscribe(s)
}

type subState struct {
	pending *Event
}

type Hub struct {
	mu sync.Mutex

	revision uint64
	dirty    map[string]struct{}
	flushDue *time.Timer

	subs map[*Subscription]*subState
}

func NewHub() *Hub {
	return &Hub{
		dirty: make(map[string]struct{}),
		subs:  make(map[*Subscription]*subState),
	}
}

func (h *Hub) Revision() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.revision
}

func (h *Hub) SubscriberCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

func (h *Hub) MarkDirty(resources ...string) {
	if len(resources) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, r := range resources {
		if r == "" {
			continue
		}
		h.dirty[r] = struct{}{}
	}
	if h.flushDue != nil {
		return
	}
	h.flushDue = time.AfterFunc(coalesceWindow, h.flush)
}

func (h *Hub) PublishNotify(payload string) {
	switch payload {
	case ResourceJobs:
		h.MarkDirty(ResourceJobs, ResourceStats)
	case ResourceWorkers:
		h.MarkDirty(ResourceWorkers)
	}
}

func (h *Hub) Subscribe() *Subscription {
	s := &Subscription{
		hub: h,
		ch:  make(chan Event, 1),
	}
	h.mu.Lock()
	h.subs[s] = &subState{}
	h.mu.Unlock()
	return s
}

func (h *Hub) unsubscribe(s *Subscription) {
	h.mu.Lock()
	if _, ok := h.subs[s]; ok {
		delete(h.subs, s)
		close(s.ch)
	}
	h.mu.Unlock()
}

func (h *Hub) ResyncEvent() Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.revision++
	return Event{
		V:         1,
		Revision:  h.revision,
		Resources: append([]string(nil), AllResources...),
		At:        time.Now().UTC(),
	}
}

func (h *Hub) flush() {
	h.mu.Lock()
	h.flushDue = nil
	if len(h.dirty) == 0 {
		h.mu.Unlock()
		return
	}
	resources := make([]string, 0, len(h.dirty))
	for r := range h.dirty {
		resources = append(resources, r)
	}
	sort.Strings(resources)
	h.dirty = make(map[string]struct{})
	h.revision++
	ev := Event{
		V:         1,
		Revision:  h.revision,
		Resources: resources,
		At:        time.Now().UTC(),
	}
	type pair struct {
		s *Subscription
		t *subState
	}
	subs := make([]pair, 0, len(h.subs))
	for s, t := range h.subs {
		subs = append(subs, pair{s, t})
	}
	h.mu.Unlock()

	for _, p := range subs {
		h.deliver(p.s, p.t, ev)
	}
}

func (h *Hub) deliver(s *Subscription, st *subState, ev Event) {
	select {
	case s.ch <- ev:
		return
	default:
	}
	select {
	case <-s.ch:
	default:
	}
	select {
	case s.ch <- ev:
	default:
		h.mu.Lock()
		if _, ok := h.subs[s]; ok {
			cp := ev
			st.pending = &cp
		}
		h.mu.Unlock()
	}
}
