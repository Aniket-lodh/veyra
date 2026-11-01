# Veyra

Distributed job queue and workflow orchestration system. PostgreSQL-first, Go backend, React frontend.

## Core principles (non-negotiable)

1. **Reliability first** — correctness over throughput, durability over latency.
2. **Observability first** — every new code path emits structured logs, metrics, and (where it crosses a boundary) traces. No silent code paths.
3. **PostgreSQL-first architecture** — Postgres is the queue, the store, and the source of truth until proven otherwise via an ADR.
4. **Clean operational UX** — ops humans must be able to inspect, drain, replay, and pause without reading source.
5. **Monorepo** — one repo, shared `packages/`, no per-service repos.
6. **Backend correctness over premature scale** — solve the semantic problem before the scaling problem.

## Hard NOs (require an ADR to override)

- **No Kafka / NATS / Redis Streams / RabbitMQ.** Postgres is the queue.
- **No Kubernetes manifests or operators.** Compose for now (`deployments/compose/`).
- **No microservice splits.** New top-level dirs under `apps/` need an ADR.
- **No undocumented queue semantics.** Any change to enqueue / dequeue / ack / lease / retry / timeout / dead-letter behavior requires the spec to be updated *first*. See [docs/decisions/0004_queue-semantics-documented-before-implementation.md](docs/decisions/0004_queue-semantics-documented-before-implementation.md).

If you believe a hard NO should be lifted, open an ADR in `docs/decisions/` and stop. Do not implement around it.

## Repo layout

```
apps/
  api/        Go service (fiber + pgx). HTTP + admin API.
  worker/     Go service. Pulls jobs, executes, reports.
  frontend/   React + TS + Tailwind + shadcn/ui. pnpm.
packages/
  queue-core/ Queue semantics + primitives. Spec-first.
docs/
  architecture/   System diagrams, queue semantics, lifecycles.
  decisions/      ADRs. Numbered, dated, immutable once accepted.
deployments/
  compose/        docker-compose.yml (dev base) + docker-compose.prod.yml (prod overlay) + .env.example.
  docker/         api.Dockerfile, worker.Dockerfile, nginx/nginx.conf. Multi-stage Go builds → alpine runtime; tini as PID 1 for SIGTERM propagation.
scripts/
  dev/            Compose up/down/logs.
  stress/         enqueue-load.sh — flood the queue to exercise multi-worker dequeue.
  chaos/          kill-random-worker.sh — validate reclaim-on-crash.
  sql/            queue_state.sql, worker_health.sql — operator psql queries.
```

`packages/` deliberately holds only what is actually shared today. Each
service owns its own `internal/config/` and `internal/logging/`; if and when
a third consumer arrives or the two diverge meaningfully, the duplication
moves to `packages/`. Speculative shared packages (and speculative empty
service folders) hide ownership and have no compile-time defenders — they
get deleted on sight.

Each subtree has its own `CLAUDE.md` with local conventions. Read the one closest to the file you're editing.

## Tooling

- Backend: Go 1.25 (see `go.work`). `gofmt`, `go vet ./...`, `go test ./...`, and `golangci-lint run` (config in `.golangci.yml`).
- Frontend: pnpm 10 and Node 24. `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint:check`.
- `make help` lists the common commands. CI (`.github/workflows/ci.yml`) runs the same checks on every pull request.
- DB: PostgreSQL. Migrations versioned under `apps/api/migrations/`.
- Local stack: `scripts/dev/up.sh` (wraps `docker compose -f deployments/compose/docker-compose.yml up --build`). Scale workers with `scripts/dev/up.sh 5`.
- Prod stack: `docker compose -f deployments/compose/docker-compose.yml -f deployments/compose/docker-compose.prod.yml up -d --build`. Adds nginx, removes the api host port (nginx is the front door), runs 3 worker replicas by default. Postgres rebinds to `127.0.0.1:5433` (loopback only) so SSH-tunneled DBeaver/psql works without ever exposing the DB to the public internet — `5432/tcp -> 127.0.0.1:5433`, NOT 0.0.0.0.

## Working agreements for AI agents

- **Read the local `CLAUDE.md` and any referenced ADR before editing.** Don't infer architecture from one file.
- **Touch one concern per change.** No drive-by refactors in a feature PR.
- **If a change crosses a queue semantic boundary, stop and update the spec first.** Then implement. Then test.
- **No new dependencies without justification.** Prefer stdlib (Go) and existing shadcn primitives (frontend).
- **Follow the disclosure rules in [AI_POLICY.md](AI_POLICY.md)** for any human-facing artifact (PRs, issues, discussions).

## Where to look when stuck

- *Why* a decision was made → `docs/decisions/`
- *How* a subsystem fits → `docs/architecture/`
- *What* a subsystem does → the nearest `CLAUDE.md` then code
- *Policy* for AI contributions → `AI_POLICY.md`
