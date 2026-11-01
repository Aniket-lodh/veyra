# scripts/

Operator tooling. Nothing here runs on the request or job path. Use these scripts to run
the stack, load it, break it on purpose, and inspect the database.

## Layout

```text
scripts/
  dev/      Run the local compose stack: up, down, logs
  stress/   Load generation: enqueue flood, unstable HTTP receiver for http_request tests
  chaos/    Failure injection, each paired with a recovery check
  soak/     Long-running soak harness: three loops (enqueue, chaos, snapshot)
  sql/      Read-only psql queries for inspecting queue state and worker health
```

## Common commands

```bash
scripts/dev/up.sh 2                 # stack with two workers, logs in the foreground
scripts/dev/logs.sh worker          # tail one service
scripts/dev/down.sh                 # stop; keeps the database volume
scripts/dev/down.sh --wipe          # stop and drop the database volume

scripts/stress/enqueue-load.sh      # flood the API with enqueue requests

scripts/chaos/kill-random-worker.sh          # kill one worker process inside its container
scripts/chaos/expect-worker-resurrection.sh  # assert that the killed worker comes back
scripts/chaos/kill-all-workers.sh            # fleet collapse
scripts/chaos/expect-fleet-resurrection.sh   # assert that the fleet recovers

psql ... -f scripts/sql/queue_state.sql      # snapshot of queue state right now
psql ... -f scripts/sql/worker_health.sql    # worker roster and heartbeat age
```

Use `docker exec <container> pkill <binary>` for chaos, not `docker kill`. A
`docker kill` sets a flag that suppresses restart policies, so the test would not reflect a
real crash. The chaos scripts already do this.

## Conventions

- **No assumptions about the working directory.** Each script resolves the repo root itself.
- **No business logic.** If a script needs more than about 50 lines of logic, it probably belongs in a service.
- **Logs to stderr, results to stdout**, so output can be piped.
- **Every chaos action has a recovery assertion** with a bounded time window. A crash that
  never recovers is a failure.
