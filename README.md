<p align="center">
  <img src="apps/frontend/app/public/icon.png" alt="Veyra" width="96" />
</p>

<h1 align="center">Veyra</h1>

<p align="center">
  A durable job queue and workflow runner built on PostgreSQL.<br />
  Queue behavior is explicit, specified, and inspectable.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue" /></a>
  <a href="https://github.com/Aniket-lodh/veyra/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Aniket-lodh/veyra/actions/workflows/ci.yml/badge.svg" /></a>
</p>

---

Veyra stores jobs, leases, retries, and dead letters in one PostgreSQL database.
Workers claim jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, heartbeat their
leases, and report results. An operator console shows queue state live. There is no
separate message broker to run.

The design favors correctness over throughput. Every queue operation is written down in
[`packages/queue-core/SPEC.md`](packages/queue-core/SPEC.md) before it is implemented.

## Features

- **Durable queue on PostgreSQL.** Enqueue, lease, ack, nack, cancel, and reclaim are
  transactional. A crashed worker's lease expires, and another worker picks the job up.
- **Retries with backoff.** Exponential or fixed backoff with jitter. Handlers can mark a
  failure as permanent so it dead-letters at once.
- **Built-in handlers.** `http_request` for outbound HTTP calls with rich result metadata,
  `send_email` for SMTP delivery, and `noop` for testing.
- **Operator console.** A React dashboard for queue stats, jobs, job attempts, workers, and
  cancellation.
- **REST API.** Enqueue, inspect, cancel, and list jobs. Swagger UI is available in development.

## Status

Veyra is early-stage and runnable. The API, worker, queue core, and operator console work
end to end. The HTTP API and the queue spec may still change before 1.0. See
[CHANGELOG.md](CHANGELOG.md).

### Known limitations

- **No authentication or authorization.** Run the API on a trusted network. Do not expose
  it to the internet.
- **Jobs wait for a capable worker.** A worker only claims jobs for handlers it runs. A job whose
  handler no worker runs (for example, from a typo) stays queued. Operators see it in queue depth
  and can cancel it. The API does not check handler names yet, so this is the main way to get stuck jobs.
- **No pause, drain, or dead-letter replay** yet. Operator console actions for these are planned.
- **No payload size limit** yet. The planned limit is 256 KiB.
- **Reclaim grace is fixed at 10 seconds** in code.
- **Partial test coverage.** Cancel, Nack permanence, backoff math, and the built-in handlers are
  tested. Enqueue, claim, ack, lease renewal, the retry scheduler, and the reclaim tick are not
  yet covered by automated tests. The API package has no tests. Each spec section lists its gaps.


## Quick start

You need Docker with the Compose plugin.

```bash
git clone https://github.com/Aniket-lodh/veyra.git
cd veyra

cp deployments/compose/.env.example deployments/compose/.env
scripts/dev/up.sh 2        # Postgres, API on :8008, and two workers
```

In another terminal, enqueue a job:

```bash
curl -X POST http://localhost:8008/jobs \
  -H 'Content-Type: application/json' \
  -d '{"handler":"noop","queue":"default","payload":{"hello":"world"}}'
```

List jobs and queue stats:

```bash
curl http://localhost:8008/jobs
curl http://localhost:8008/queue/stats
```

To run the operator console against that API:

```bash
cd apps/frontend/app
pnpm install
VITE_API_PROXY_TARGET=http://localhost:8008 pnpm dev
```

Then open the URL Vite prints, usually <http://localhost:5173>.

Stop the stack with `make down`. The database volume is kept.

## Architecture

```text
 Operator console (React)
          │  HTTP
          ▼
 API (Go, Fiber)  ── migrations, sweeper, retry scheduler, reclaim driver
          │  pgx
          ▼
 PostgreSQL  ◀── queue state, leases, attempts, workers
          ▲  pgx
          │
 Workers (Go)  ── claim, execute handler, heartbeat, ack or nack
```

- `apps/api`: HTTP API and background loops.
- `apps/worker`: job runner and handler registry.
- `packages/queue-core`: queue semantics, shared by the API and the worker.
- `apps/frontend/app`: operator console.

For more detail, read [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)
and [`docs/architecture/database-schema.md`](docs/architecture/database-schema.md).

## Repository layout

```text
apps/
  api/              Go HTTP API and background loops
  worker/           Go worker and handlers
  frontend/app/     React operator console
packages/
  queue-core/       Queue semantics and SQL (spec: SPEC.md)
deployments/
  compose/          Docker Compose stacks and .env.example
  docker/           Dockerfiles and nginx config
docs/
  architecture/     System and schema design
  decisions/        Architecture decision records (ADRs)
  runbooks/         Operational procedures
scripts/            Dev, stress, chaos, soak, and SQL helpers
```

## Configuration

Each app reads its settings from environment variables and documents them in its
`.env.example`:

- [`deployments/compose/.env.example`](deployments/compose/.env.example): Compose settings
- [`apps/api/.env.example`](apps/api/.env.example): API settings
- [`apps/worker/.env.example`](apps/worker/.env.example): worker settings, including SMTP
- [`apps/frontend/app/.env.example`](apps/frontend/app/.env.example): console settings

Never commit a real `.env` file.

The default database password (`veyra`) is for local development only. Change it for any
shared or public deployment.

## Development

```bash
make help               # list all commands
make test               # Go unit tests and frontend typecheck
make test-integration   # queue tests against real Postgres (needs Docker)
make lint               # gofmt, golangci-lint, and frontend lint
```

The project rules for contributors and AI coding agents live in [`CLAUDE.md`](CLAUDE.md)
and the nearest `CLAUDE.md` in each directory.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Queue-semantics changes
need a spec update first. Follow [AI_POLICY.md](AI_POLICY.md) for AI-assisted work.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
[SECURITY.md](SECURITY.md), not public issues.

## License

Veyra is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License v3.0](LICENSE), or any later version.

Copyright (C) 2026 Aniket Lodh

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY.
See the license for details. If you run a modified version of Veyra as a network service,
the AGPL requires you to offer its source code to the users of that service.
