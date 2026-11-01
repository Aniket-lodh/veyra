# Contributing to Veyra

Thanks for your interest in Veyra. Before you start, read this page and the
[AI usage policy](AI_POLICY.md). Veyra is deliberately conservative, so a short
discussion first saves everyone time.

## Ground rules

1. **Open an issue first** for anything non-trivial. Pull requests that do not
   reference an accepted issue may be closed.
2. **One concern per pull request.** No drive-by refactors in a feature PR.
3. **Queue semantics are spec-first.** Any change to enqueue, dequeue, ack, nack,
   lease, retry, timeout, cancel, or dead-letter behavior must update
   [`packages/queue-core/SPEC.md`](packages/queue-core/SPEC.md) before the code.
   See [ADR-0004](docs/decisions/0004_queue-semantics-documented-before-implementation.md).
4. **Hard NOs need an ADR.** No Kafka, NATS, Redis, RabbitMQ, Kubernetes, or new
   top-level services under `apps/` without an accepted ADR in `docs/decisions/`.
5. **Disclose AI assistance** in the PR body, as described in
   [AI_POLICY.md](AI_POLICY.md).

Read the nearest `CLAUDE.md` before editing code. These files hold the local
conventions for each part of the repo.

## Development setup

Requirements:

- Go 1.25 or newer
- Node.js 24 and pnpm 10 (the version is pinned in `apps/frontend/app/package.json`)
- Docker with the Compose plugin

Run the full stack (Postgres, API, worker):

```bash
cp deployments/compose/.env.example deployments/compose/.env
scripts/dev/up.sh 2        # two workers
```

Run the frontend against a local API:

```bash
cd apps/frontend/app
pnpm install
VITE_API_PROXY_TARGET=http://localhost:8008 pnpm dev
```

## Checks to run before pushing

Go (run in each module you touched: `packages/queue-core`, `apps/api`, `apps/worker`):

```bash
gofmt -l .            # must print nothing
go vet ./...
go test ./...
golangci-lint run     # https://golangci-lint.run/welcome/install/
```

Queue integration tests use a real Postgres through testcontainers. They need a running Docker daemon:

```bash
cd packages/queue-core
go test -tags integration -count=1 ./...
```

Frontend, from `apps/frontend/app`:

```bash
pnpm typecheck
pnpm lint:check
pnpm build
```

`make help` lists the same commands.

## Testing expectations

- Queue behavior is tested against real Postgres. Do not mock the database.
- Several queue behaviors have no automated test yet. Each spec section lists its gaps in a
  *Verified by* block. When you change one of those behaviors, add the missing test.
- Tests that cover queue behavior name the spec section they verify.
- Handlers must be idempotent and must respect context cancellation.

## Commit and PR style

- Write commit subjects in the imperative mood, for example `Add cancel endpoint`.
- Keep subjects under 72 characters. Put context in the body.
- Fill in the pull request template, including the AI assistance section.

## Licensing of contributions

Veyra is licensed under the [GNU AGPL-3.0](LICENSE). By submitting a contribution,
you agree that it is licensed under the same terms.

## Conduct and security

- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
