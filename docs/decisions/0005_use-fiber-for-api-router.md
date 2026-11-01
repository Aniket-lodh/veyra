# 0005 — Use GoFiber for the API Router

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Veyra core
- **Supersedes:** Implicit choice of `chi` from initial scaffolding.

## Context

`apps/api` needs an HTTP router. The Go ecosystem offers several reasonable choices:

- **`net/http` + `ServeMux`** — stdlib, since 1.22 has decent routing.
- **`chi`** — small, idiomatic, `net/http`-compatible, middleware-first.
- **`gin` / `echo`** — `net/http`-based, opinionated, batteries included.
- **`fiber`** — built on `fasthttp` (not `net/http`), Express-like API, batteries included.

The initial scaffolding (`apps/api/CLAUDE.md` in its first revision) named `chi`, but no ADR justified it — it was a default, not a decision.

The maintainer prefers fiber's API ergonomics. There is no measured throughput requirement that motivates the choice, and the project's principles explicitly prioritize backend correctness over premature scale. This ADR records the choice honestly so the trade-offs are not forgotten.

## Decision

`apps/api` uses **GoFiber v3** (`github.com/gofiber/fiber/v3`) as its HTTP router.

- All HTTP handlers have the signature `func(c fiber.Ctx) error`.
- Request context is obtained via `c.UserContext()` and passed as the first argument to every downstream call, preserving the project-wide "`context.Context` first" rule.
- WebSocket support uses `github.com/gofiber/contrib/websocket`.
- Tracing/metrics middleware uses fiber-specific instrumentation (`github.com/gofiber/contrib/otelfiber` or equivalent), since `net/http` instrumentation does not apply.

## Consequences

### Positive
- Maintainer finds fiber's API more productive, which translates to faster iteration during the phase where iteration speed matters most.
- Fiber ships more out of the box (parameter parsing, validation hooks, rate limiting, etc.), which means fewer small dependency decisions early on.

### Negative — accepted knowingly
- **`fasthttp` is not `net/http`.** The large ecosystem of `net/http`-based middleware, instrumentation, and tooling does not work directly:
  - OpenTelemetry HTTP instrumentation must use the fiber-specific package.
  - `net/http/pprof.Handler`, `expvar.Handler`, and `httptest` do not apply directly; equivalents must be wired through fiber middleware.
  - Third-party libraries that expose `http.Handler` middleware (auth, logging, CORS variants) require shims or fiber-native equivalents.
- **WebSocket adds a dependency.** Where `chi` would have used `coder/websocket` or `gorilla/websocket` directly over `net/http`, fiber requires `gofiber/contrib/websocket`. The dependency surface grows by one package.
- **The "observability first" principle is harder to satisfy by default.** Standard observability recipes (e.g. OTel HTTP server middleware) require the fiber-specific port. We accept the responsibility to wire equivalent coverage.
- **Idioms diverge from idiomatic Go.** Fiber's `c.Locals`, `c.Bind`, etc., differ from the `net/http` patterns most Go reviewers expect. New contributors familiar with idiomatic Go web services will need a brief orientation.

### Neutral / follow-ups
- The `apps/api/CLAUDE.md` Conventions section is updated in the same change as this ADR so the rules around `context.Context`, error handling, and observability are restated in fiber terms.
- If, at some future point, an ecosystem cost from this choice materially bites (e.g., a piece of net/http instrumentation we genuinely need is unavailable in a fiber port), the right response is a new ADR — not a quiet partial migration.

## Alternatives considered

- **`chi`** — small, `net/http`-compatible, would have preserved access to the standard ecosystem. Rejected: maintainer preference for fiber's API.
- **`net/http` + `ServeMux` (1.22+ routing)** — zero dependencies, fully standard. Rejected for the same reason.
- **`gin` / `echo`** — also `net/http`-based, also more opinionated than chi. Rejected: if we were optimizing for ergonomics within `net/http`, chi was still preferred at decision time, and we chose to leave `net/http` entirely.

## References

- GoFiber: https://gofiber.io
- The trade-offs of `fasthttp` vs `net/http` are well documented in fiber's own README and the `fasthttp` README. This ADR is not the place to re-litigate them.
