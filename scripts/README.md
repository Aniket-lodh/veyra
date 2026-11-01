# scripts/

Operator tooling. None of this is on the runtime path; everything in here is
something a human reaches for to exercise the system, inspect state, or
deliberately break it to confirm the system recovers.

## Layout

```
scripts/
  dev/      Local dev convenience (compose up/down, log tails).
  stress/   Load injection — enqueue floods, ack races.
  chaos/    Deliberate failure injection — kill containers, partition the network.
  sql/      Ready-made psql queries against the operator schema.
```

## Why these exist

Veyra is becoming distributed infrastructure software, and distributed
infrastructure cannot be validated by unit tests alone. The bugs that matter
— reclaim races, lease ownership transitions, restart-mid-execution — only
surface under real container churn against a real Postgres. These scripts
are the cheapest way to reproduce that churn on a laptop or VPS.

## Conventions

- **No assumptions about cwd.** Every script accepts repo root as its
  working dir and references files relative to it.
- **No business logic.** A script that needs more than ~50 lines should
  probably be a service, not a shell file.
- **Logs to stderr, results to stdout.** So you can pipe.
