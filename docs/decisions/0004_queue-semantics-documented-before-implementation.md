# 0004 — Queue Semantics Documented Before Implementation

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Veyra core
- **Supersedes:** —

## Context

A job queue's correctness is its semantics. "At-least-once," "exactly-once with idempotency key," "visibility timeout vs lease," "ordered per key vs unordered," "retry counted on lease expiry vs explicit nack" — these are not implementation details. They are contracts with every caller, worker handler, and operator.

When semantics are derived from code rather than written down:

- Different consumers (the API, the worker, the retry layer, the operator UI, the metrics) end up making subtly different assumptions.
- Behavior drifts over time as engineers fix bugs without realizing they're changing a contract.
- Tests verify *what the code does* rather than *what the code should do*.
- AI agents and new contributors can't audit correctness without reading the entire codebase.

## Decision

The queue's semantic contract lives in `packages/queue-core/SPEC.md` (with longer treatments in `docs/architecture/queue-semantics.md` as needed). The spec is written **before** the implementation.

Specifically:

- Any change to the observable behavior of `Enqueue`, `Dequeue`, `Lease`, `Ack`, `Nack`, `Heartbeat`, `Timeout`, `Cancel`, retry scheduling, priority, delayed visibility, or dead-letter triggers requires updating the spec first.
- Each spec section names the test(s) that verify it.
- Implementation PRs link to the spec section they implement; reviewers (human or AI via `queue-spec-guardian`) confirm the link.
- The `/queue-spec` slash command scaffolds new sections so the template is consistent.

## Consequences

### Positive
- Every consumer of the queue reads the same contract.
- Reviews can be precise: "this code disagrees with section X" or "this section is silent on edge case Y."
- Tests become regression checks against a stated contract, not against past behavior.
- Onboarding (human and AI) starts with the spec, not with reverse-engineering.

### Negative
- Up-front writing cost. A change that would have been "ten lines of Go" becomes "ten lines of Go plus a spec section."
- Bureaucracy risk if the rule is applied to non-semantic refactors. The rule applies to *observable behavior*, not internal restructuring.

### Neutral / follow-ups
- The `queue-spec-guardian` subagent enforces this on PRs.
- The spec is a living document with version-controlled history; it is allowed to evolve, just not to lag.

## Alternatives considered

- **Code is the spec.** Rejected — see Context. This is how queues become subtly broken.
- **Spec lives in a separate doc site.** Rejected — drift risk; review cycle is detached from code.
- **Write the spec after the code is stable.** Rejected — "stable" never arrives, and by then divergence is too costly to fix.

## References

- [ADR-0002](0002_postgresql-as-primary-store-and-queue.md) — the substrate the spec sits on.
- `packages/queue-core/CLAUDE.md` — the local-scope restatement of this rule.
