# apps/api

Go HTTP service. Public API + admin API + WebSocket for live job state.

## Stack

- **Router:** `fiber` (v3) — `fasthttp`-based, Express-like API. See [ADR-0005](../../docs/decisions/0005_use-fiber-for-api-router.md) for the rationale and trade-offs.
- **DB:** `pgx` (v5) directly. No ORM. Hand-written SQL or `pgx`'s scanning.
- **Migrations:** `apps/api/migrations/NNNNNN_description.{up,down}.sql` (6-digit prefix, the `golang-migrate` convention). Numeric, monotonic, never rewritten after merge. Applied at startup by `internal/database.RunMigrations`, which uses `golang-migrate/v4` as a library against a `file://migrations` source.
- **WebSocket:** `github.com/gofiber/contrib/websocket` (fiber-native, not `gorilla/websocket`).
- **HTTP instrumentation:** fiber-specific (`github.com/gofiber/contrib/otelfiber` or equivalent). Standard `net/http` middleware does *not* apply — fiber sits on `fasthttp`, not `net/http`.

## Layout

```
apps/api/
  cmd/api/        main.go — process wiring ONLY (env → logger → db → app → routes → listen).
  internal/
    config/       Env-var loader (Config struct + DatabaseURL helper).
    database/     pgx pool constructor + golang-migrate runner.
    debug/        Dev-only /internal/debug/* routes against queuecore primitives. Mounted unconditionally today; ingress rejects /internal/* in prod.
    health/       /health liveness probe (DB ping).
    http/         fiber.App constructor: app config + middleware chain + central error handler. Does NOT know about domain routes.
    jobs/         Job HTTP layer. Wraps queuecore in fiber handlers + the response DTO that matches the frozen frontend contract.
    logging/      slog bootstrap (Setup(env, level)). Sets slog.Default. No logger interface, no wrapper.
    middleware/   request id + access log. Each middleware writes to ctx (via SetContext), never c.Locals.
    stats/        GET /queue/stats. Thin HTTP skin over queuecore.Repository.QueueStats; SQL ownership stays in queue-core.
    workers/      GET /workers. Owns SQL against the `workers` table directly (observability-only table; queue-core deliberately does NOT touch it). Joins lease info in-process via queuecore.Repository.ListRunningLeases — never via SQL JOIN against workers.
  migrations/     Numbered SQL pairs (golang-migrate). See "Migrations checklist" below.
  docs/
    architecture/  API-local design notes.
```

Folders that do NOT exist here are intentional: there is no `queue/`,
`queues/`, `retries/`, `leases/`, or `websocket/`. Queue semantics live
in `packages/queue-core` (their ownership; ADR-0004); the others have no
implementation yet. **Do not create an empty folder to "reserve" a name**
— empty folders pretend a boundary exists that the compiler does not
enforce, and they confuse every other reader.

## Conventions

- **`context.Context` first.** Every function that does I/O takes `ctx context.Context` as its first parameter. In a fiber handler, obtain it via `c.UserContext()` and pass it to every downstream call. Never use `context.Background()` deep in the call stack.
- **Handler signature:** `func(c fiber.Ctx) error`. Return errors; let fiber's error handler map them to HTTP codes. Do not write status codes from inside business logic.
- **Wrap pgx errors with location.** `fmt.Errorf("jobs.Enqueue: %w", err)`. Don't swallow.
- **No global state.** Pass dependencies via constructors. The `main` package wires the fiber app and routes; nothing else does.
- **Handlers are thin.** Handler → service method → repository. The handler parses input (via `c.Bind*`), validates, calls a service, and translates the returned error to an HTTP response — that's it. No business logic in the handler.
- **Observability is mandatory.** Every handler logs a structured entry; every queue operation emits a metric. Use `packages/logger` for logs and the fiber-native OTel middleware for traces — `net/http` instrumentation will not work here.
- **Errors are typed when callers branch on them.** Use sentinel errors (`var ErrJobNotFound = errors.New(...)`) and `errors.Is`. No string matching. Map sentinel errors to HTTP status codes in a central fiber error handler, not at each call site.
- **No `c.Locals` for request-scoped data that crosses package boundaries.** Use the request `context.Context` instead — it travels through service and repository layers; `c.Locals` does not.

## Queue boundary rule

Anything under `internal/queue/`, `internal/jobs/`, or `internal/retries/` may **only** change behavior that is already described in `packages/queue-core`'s spec. If you need different semantics, update the spec first. See [the queue spec ADR](../../docs/decisions/0004-queue-semantics-documented-before-implementation.md).

## Testing

- `go test ./...` from `apps/api/`.
- Integration tests hit a real Postgres (via the compose stack or testcontainers). **Do not mock the database** — the entire queue's correctness lives in SQL semantics; mocks lie.
- Tests covering queue behavior must reference the spec section they verify.

## Migrations checklist

Before adding a migration:

- [ ] Numbered after the highest existing migration. No gaps, no edits to merged migrations.
- [ ] Both `up.sql` and `down.sql` exist. Down must actually invert.
- [ ] No `DROP COLUMN` / `DROP TABLE` without a deprecation migration shipped at least one release prior.
- [ ] New indexes on populated tables use `CREATE INDEX CONCURRENTLY`.
- [ ] `NOT NULL` additions backfill in a separate prior migration, then add the constraint.
- [ ] Each statement runs in its own transaction unless the migration explicitly needs atomicity (and the runner supports it).

A migration that violates the checklist needs an explicit note in the PR body explaining why.
