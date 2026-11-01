# Agent instructions

This file is read by AI coding agents, including Cursor. The full project rules live in
[`CLAUDE.md`](CLAUDE.md). Read it before you change any code.

The most important rules:

- Veyra uses PostgreSQL as the queue. Do not add Kafka, NATS, Redis, RabbitMQ, or Kubernetes
  without an accepted ADR in `docs/decisions/`.
- Queue semantics are spec-first. Update `packages/queue-core/SPEC.md` before you change
  enqueue, dequeue, ack, nack, lease, retry, timeout, cancel, or dead-letter behavior.
- Read the nearest `CLAUDE.md` for the directory you are editing: `apps/api`, `apps/worker`,
  `apps/frontend/app`, or `packages/queue-core`.
- Keep each change to one concern.
- Disclose AI assistance in commit and pull request text, as described in `AI_POLICY.md`.
- Do not read or print `.env` files. Use `.env.example` files as the reference for configuration.
