# apps/api

Go HTTP service. Serves the REST API and runs the background loops that keep the
queue healthy (stale-worker sweeper, retry scheduler, reclaim driver).

## Stack

- **Router:** `fiber` v3 (`fasthttp`-based). See [ADR-0005](../../docs/decisions/0005_use-fiber-for-api-router.md).
  Standard `net/http` middleware does not apply.
- **DB:** `pgx` v5 directly. No ORM. Hand-written SQL.
- **Queue:** `packages/queue-core`. The API never writes queue state with its own SQL.
  The only exception is the `workers` table (see below).
- **Migrations:** `apps/api/migrations/NNNNNN_description.{up,down}.sql`. Applied at
  startup by `internal/database.RunMigrations` (`golang-migrate` against `file://migrations`).
- **Swagger UI:** mounted only when `APP_ENV=development`, from `docs/swagger.json`.
- **Auth:** `internal/auth/` — operator login + API keys. Public: `/health`, `/auth/*` (except `/auth/me`).
- **Live updates:** `internal/live/` — `GET /events` SSE invalidation bus driven by Postgres `LISTEN veyra_ui` (ADR-0009). Not WebSockets; workers still poll.
- **Not present yet:** OIDC/SSO, invite more users, metrics.

## Layout

```
apps/api/
  cmd/api/        main.go: wiring only (env, logger, DB, migrations, routes, loops, listen, shutdown)
  internal/
    config/       env loader (the only place that calls os.Getenv for API settings)
    database/     pgx pool and migration runner
    debug/        /internal/debug/* routes (claim, succeed, fail, renew). Dev only.
    auth/         Bearer API-key verify, scopes, /api-keys admin routes (ADR-0007)
    health/       GET /health (DB ping)
    http/         fiber app constructor, middleware chain, error handling
    jobs/         /jobs routes: create, list, get, cancel. Thin wrapper over queuecore.
    live/         GET /events SSE + LISTEN fan-out for the operator console (ADR-0009).
    logging/      slog setup
    middleware/   request ID (X-Request-Id) and access log
    reclaim/      periodic reclaim driver. Calls the queue-core reclaim primitive.
    retries/      retry scheduler. Promotes due `failed` rows to `queued`.
    stats/        GET /queue/stats. Thin wrapper over queuecore.QueueStats.
    workers/      GET /workers, and the stale-worker sweeper. Owns SQL on the `workers` table.
  docs/swagger.json   hand-maintained OpenAPI 3.0 spec. Update it with every route change.
  migrations/         numbered SQL pairs
```

Do not create an empty folder to reserve a name. An empty folder suggests a boundary
that the compiler does not enforce.

## Conventions

- **`context.Context` first.** Every function that does I/O takes `ctx` as its first
  parameter. In handlers, use `c.Context()`. Never use `context.Background()` deep in the call stack.
- **Handler signature:** `func(c fiber.Ctx) error`. Return errors, and map them to
  HTTP status codes in the handler's response helpers (`badRequest`, `internalError`,
  `mapCompletionError`).
- **Handlers are thin:** parse and validate input, call queue-core, and translate the
  result. No business logic in handlers.
- **Errors are typed when callers branch on them.** Use sentinel errors from
  queue-core (`ErrJobNotFound`, `ErrLeaseLost`, `ErrLeaseExpired`, `ErrNotCancellable`)
  and `errors.Is`. Never match on strings.
- **Wrap errors with the location:** `fmt.Errorf("jobs.Create: %w", err)`.
- **No global state.** Pass dependencies through constructors. `main` wires everything.
- **Request-scoped data** travels in `context.Context`, not `c.Locals`, when it crosses packages.
- **Observability.** Every handler logs one structured entry (`slog`, with an `event`
  field). Queue operations emit the events listed in `SPEC.md`. Use `internal/logging`.
  There is no metrics backend yet.
- **Configuration.** Every new variable gets a line in `apps/api/.env.example` and in the
  README configuration section.

## Queue boundary rule

`internal/jobs`, `internal/retries`, and `internal/reclaim` may only invoke queue-core. They
must not change queue behavior. If a behavior change is needed, update
`packages/queue-core/SPEC.md` first. See [ADR-0004](../../docs/decisions/0004_queue-semantics-documented-before-implementation.md).

The `workers` table is observability only. Queue-core does not read it. The `GET /workers`
handler joins lease data in-process through `queuecore.Repository.ListRunningLeases`. It
never JOINs `workers` in SQL against `jobs`.

## Testing

- `go test ./...` from `apps/api/`. Auth and `internal/live` have unit tests;
  live NOTIFY→hub coverage uses `go test -tags integration ./internal/live/...`.
- Queue behavior is tested in `packages/queue-core`, against real Postgres via
  testcontainers (`go test -tags integration ./...`). Do not mock the database.

## Migrations checklist

Before adding a migration:

- [ ] Numbered after the highest existing migration. No gaps. Never edit a merged migration.
- [ ] Both `up.sql` and `down.sql` exist, and `down` actually inverts `up`.
- [ ] No `DROP COLUMN` or `DROP TABLE` without a deprecation migration shipped in an earlier release.
- [ ] New indexes on populated tables use `CREATE INDEX CONCURRENTLY`.
- [ ] `NOT NULL` additions backfill in a separate, earlier migration.
- [ ] Each statement runs in its own transaction unless the migration needs atomicity.

If a migration breaks this list, explain why in the PR body.
