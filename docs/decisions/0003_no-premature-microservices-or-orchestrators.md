# 0003 — No Premature Microservices, Kafka, or Kubernetes

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Veyra core
- **Supersedes:** —

## Context

Distributed systems projects accrete infrastructure quickly: a service mesh here, an orchestrator there, a message bus "because we'll need it eventually." Each addition multiplies operational surface, slows onboarding, and rarely pays back during the phase of life where the project is still finding its correctness.

Veyra's value proposition is *operational simplicity for job queueing*. Adopting heavy infrastructure before the core semantics are correct undermines the entire project.

## Decision

For the foreseeable future, Veyra deploys as a small set of long-lived processes against a PostgreSQL primary. Specifically:

- **No Kubernetes** for application deployment. Docker Compose in `deployments/compose/` is the deployment target until proven insufficient.
- **No Kafka / NATS / RabbitMQ / Redis Streams.** Postgres is the queue (see [ADR-0002](0002_postgresql-as-primary-store-and-queue.md)).
- **No microservice splits.** The three apps (`apps/api`, `apps/worker`, `apps/frontend`) cover the system. Splitting `apps/api` into sub-services requires an ADR.
- **No service mesh.** Direct HTTP between processes is fine until it isn't.

Any change introducing one of the above requires a superseding ADR that specifically names the component, the problem it solves, and what we tried first.

## Consequences

### Positive
- One deploy command. One log aggregation pattern. One networking model.
- Contributors can run the full stack locally in minutes.
- The team's attention stays on queue correctness and operational UX rather than YAML.

### Negative
- We may, at some point, outgrow Compose for production scale. We accept paying that migration cost later in exchange for not paying it now.
- Folks familiar with k8s-first deployments may find the simplicity surprising.

### Neutral / follow-ups
- The `architecture-guard` subagent enforces this ADR mechanically on diffs.
- We will revisit this ADR when we hit a concrete, measured limit — not before.

## Alternatives considered

- **"Just add a Helm chart, it's free."** Rejected — it is not free; it is a permanent operational dependency.
- **Start with Kafka because that's the standard for queues.** Rejected — see [ADR-0002](0002_postgresql-as-primary-store-and-queue.md).
- **Split the API into auth-service, jobs-service, etc. early.** Rejected — premature decomposition makes refactoring harder, not easier. We will decompose when seams emerge from real use.

## References

- [ADR-0002](0002_postgresql-as-primary-store-and-queue.md) — PostgreSQL as primary store and queue.
