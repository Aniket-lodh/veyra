# Soak report — 2026-05-26 (run 20260526T122313Z)

> Reports for future soak runs go in this same file, appended chronologically.
> Each run gets its own dated section. Findings flow into ADRs, runbooks,
> SPEC updates, and follow-up issues — not into the next feature.

## Headline

The soak terminated useful learning ~1h after start: by **13:24Z**, every
worker container was gone from the host and never reappeared for the
remaining ~5 hours of the run. The chaos loop kept firing into an empty
fleet, the enqueue loop kept growing the queue (`queue_depth` rose from
180 → 11,143 — exactly the enqueue rate, untouched by any consumer), and
`succeeded` flatlined at 3,082 from 13:24Z onward.

The system did not crash. It silently lost its consumer fleet and showed
no obvious red light on the API side. That is the single most important
finding of this run.

## Run parameters

| Knob | Value |
|---|---|
| Run ID | `20260526T122313Z` |
| Stack | prod overlay (nginx + api + worker×3 + postgres) |
| Duration (planned / actual) | 21,600s / 21,601s |
| Enqueue | 100 jobs every 180s → 12,000 lines |
| Chaos | rotation every 600s: worker SIGTERM → worker SIGKILL → api restart → pg restart |
| Snapshot interval | 60s → 346 snapshots, 9,497 lines |
| Logs | `soak-logs/20260526T122313Z-{enqueue,chaos,snapshot,summary}.{log,txt}` |

## Findings by area

| Area | Status | Evidence |
|---|---|---|
| **Retry lag** | Healthy while consumers existed | `oldest_failed_due_lag_seconds` max = **3s**; `retry_due_now` max = **3**. Scheduler kept up with retry promotion under load. |
| **Reclaim behavior** | **Broken in the no-worker steady state** | At 13:24Z and for the remaining 5h: `jobs_in_flight=2`, `jobs_with_expired_lease=2`, `attempts_lease_lost=22` plateau. Two jobs sat in `running` with expired leases that nothing reclaimed because no workers remained. The reclaim path is wired through `dequeue`, so a queue with no dequeuers cannot self-heal. |
| **Memory** | Stable, no leaks | api peak **19.74 MiB**, workers peak **8.9 MiB**, postgres peak **45.91 MiB**, nginx ~7 MiB. No drift across 6h. |
| **Worker churn** | **Flapping → terminal** | Workers respawned exactly once (at 12:40Z, restoring 3→3 briefly); after the second SIGKILL at 12:43Z the count never recovered to 3, and after the SIGKILL at 13:23Z (followed by api_restart 13:33Z + pg_restart 13:43Z) every worker container was gone from `docker stats` and from `docker ps --filter service=worker`. Chaos loop reported `no running veyra-worker containers found` 16 times in a row. |
| **Scheduler** | Healthy until queue starved | Retry lag never exceeded 3s while consumers existed. After 13:24Z `retry_due_now=0` and `failed_total` only drifted from 215→215 — scheduler is still running but has nothing to promote (failed→queued moves don't help when nothing dequeues). |
| **DB restart recovery** | Clean (single observation, then no consumers to test against) | Only 1 `snapshot_warn=sql_failed` across the entire run (during the 13:43Z pg_restart). pgx pool reconnected; api kept logging; no cascade. Recovery under load could not be re-tested because workers were gone by the next pg_restart. |
| **DLQ growth** | Expected during chaos, plateaued correctly afterwards | DLQ rose 28 → 130 across the chaos-active window (12:23–13:24Z), then **plateaued at 130** for 5h — consistent with no further attempts happening. No runaway. |
| **Reconnect behavior (workers)** | **Not actually exercised** | The api/pg restarts could not be tested against live workers after 13:24Z. The one observed worker-side reconnect (12:53Z api_restart, workers still alive) was clean (no error spike). |
| **UI polling** | Not observed | Dashboard was not driven during the run; no client-side metrics were captured. Add a synthetic poller to the soak harness. |
| **Logs** | Useful at top, thin on the failure | Quiet baseline (warns 3–6/min, errors 0–1/min). But there is no log line in this report that explains *why workers didn't restart*. The signal that should have screamed — "worker container exited and was not recreated" — is invisible to the snapshot. That is a sufficiency gap. |

## Categorized findings

### Category A — Immediate bugs (fix before any new feature)

**A1. Worker containers are not respawning after chaos kills.**
- Symptom: after `docker kill --signal SIGKILL`, the worker is gone from `docker stats` and `docker ps --filter "label=com.docker.compose.service=worker"` indefinitely.
- Stack ran on the prod overlay (`deployments/compose/docker-compose.prod.yml`). The base service has `restart: unless-stopped`. The prod overlay layered `deploy.replicas: 3` + `deploy.restart_policy { condition: on-failure, max_attempts: 0 }` on top.
- **Diagnosed empirically (2026-05-28) — TWO distinct root causes:**

  **Cause 1 (compose-side):** `docker inspect` on a running worker showed effective `HostConfig.RestartPolicy = {"Name":"on-failure","MaximumRetryCount":0}` — confirming `deploy.restart_policy` IS honored by `docker compose up` (the earlier "swarm-only" hypothesis was wrong) and overrides the base `restart: unless-stopped`. A controlled SIGKILL on `veyra-worker-1` left the container in `state=exited exitCode=137 restartCount=0` indefinitely. The engine interprets `MaximumRetryCount: 0` **literally as "zero retries"**, NOT as "unlimited" as some Docker docs suggest. The `on-failure` policy with `max_attempts: 0` is therefore a no-op for any failure. **Fixed: removed the `deploy.restart_policy` block from the prod overlay; base `restart: unless-stopped` now takes effect.**

  **Cause 2 (chaos-script-side):** even after fixing the compose policy to `unless-stopped`, a `docker kill --signal SIGKILL veyra-worker-1` still failed to restart the container (`restartCount=0`). Root cause: the Docker daemon sets a `HasBeenManuallyStopped` flag whenever `ContainerKill` or `ContainerStop` is invoked via the API (i.e. any `docker kill` / `docker stop` from the CLI), and **`unless-stopped` / `always` policies do NOT restart manually-stopped containers** — by design. Real worker crashes (panic, OOM, kernel kill, segfault) do NOT go through `docker kill`, so this flag isn't set, so the policy fires correctly. The chaos script was simulating the wrong failure mode all along: "operator typed `docker kill`", not "process crashed".

  Verified correct simulation: `docker exec veyra-worker-2 sh -c 'pkill -KILL worker'` (kill the worker process from inside the container, NOT PID 1 — PID 1 is `/sbin/tini` and Linux PID-namespace semantics make PID 1 immune to SIGKILL from within its own namespace). The result: tini reaps the dead child, exits with code 137, container exits "naturally" from the daemon's perspective, `unless-stopped` fires, container restarts with `restartCount=1` within ~1s.

- This fully explains the 2026-05-26 soak: every SIGKILL'd worker stayed `exited` (cause 1); even *if* the policy had been correct, the `docker kill` chaos method would still not have triggered restart (cause 2). The surviving containers from the soak (`f916e65d19ea`, `b80ea1606a9a`, `e3fc7bbf7c74`) were still present on disk in `exited (137)` state until brought back manually by `docker compose up -d` on 2026-05-28.
- Why this is A and not C: this directly negates the soak's whole reliability story. "We can survive worker crashes via reclaim" is meaningless if the container never comes back.
- **Fixes:**
  - **A1.2 (done):** `deployments/compose/docker-compose.prod.yml` — `deploy.restart_policy` block removed; comment added explaining why and warning against re-introduction.
  - **A1.3 (done):** `scripts/chaos/kill-random-worker.sh` rewritten to use `docker exec <container> pkill -<sig> worker` (kill the worker process from inside, not the container; PID 1 is `tini` and is namespace-immune to SIGKILL from within). Captures the baseline `RestartCount` before the kill — capturing it in the assertion script races with the daemon's ~1s restart and reads the post-restart value. New `scripts/chaos/expect-worker-resurrection.sh` polls `docker inspect` until `RestartCount > baseline` and emits `worker_recovery_seconds=<n>` with a default 30s bound. `scripts/soak/run.sh` pairs every worker chaos action with the assertion via a `chaos_kill_with_assertion` helper, and surfaces successful + failed recoveries in the summary instead of leaving them buried in the chaos log.
  - **A3 (done):** `scripts/soak/sql/snapshot.sql` rewritten — every `worker_state` and `job_status` enum value now emits a line per snapshot (LEFT JOIN against `unnest(enum_range(NULL::enum))`), and `queue_depth:` lines now LEFT JOIN against `DISTINCT queue FROM jobs` so an emptying queue still emits `=0` instead of dropping out of the stream.
  - **B5 (done):** `snapshot.sh` emits `worker_container:<service> id=<id> started_at=<iso> restart_count=<n> state=<s>` per worker container per tick. `snapshot.sql` emits one `worker_runtime:<workers.id> hostname=<h> state=<s> started_at=<ts> last_heartbeat_at=<ts>` line per row in the workers table and `worker_generation_count:<hostname>=<n>` per hostname. End-to-end check against the live DB on 2026-05-28 produced both Docker-layer (`worker_container ... restart_count=2`) and application-layer (`worker_generation_count:a42e082f3bbc=3`) evidence for the same chaos test — confirming the two layers agree.

**A2. Stuck `running` jobs with expired leases that nothing reclaims.**
- 2 jobs sat in `status='running' AND lease_expires_at < now()` for 5h with no progress.
- Root cause: the reclaim path is *inside* `dequeue`. When no dequeues happen (no workers), expired leases never get reclaimed. The queue cannot self-heal without consumers.
- The missing piece is a **second invocation site** for reclaim — typically a periodic api-side tick that runs even when no worker is asking — so that a fleet outage cannot produce permanently stuck `running` rows.
- **Critical implementation constraint (do not skip):** the new invocation site must NOT be a second implementation. Reclaim today lives inside the dequeue SQL; if a separate "sweeper reclaim" is written alongside it, the two will drift on attempt accounting, DLQ promotion thresholds, lease-lost telemetry, and edge cases. Extract reclaim into a single primitive in `packages/queue-core/` (e.g. `queue.Reclaim(ctx, db, ReclaimOpts{...}) → ReclaimResult`) with one set of invariants, one set of metrics, one set of logs. Dequeue invokes it inline; the api-side tick invokes it on a timer. Same logic, same invariants, same observability — **always**.
- This is a queue-semantics change and must be specced in `packages/queue-core/SPEC.md` before implementation (see [[feedback-queue-spec-first]], [[feedback-shared-semantics-shared-primitive]]). The spec must define: what triggers reclaim (lease expiry only? state predicate?), what reclaim does to `job_attempts`, when reclaim escalates to `failed`/`dead_lettered` vs returning to `queued`, and the ordering vs the retry scheduler.

**A3. Snapshot reports `worker_count:active=N` only when N>0.**
- The snapshot SQL does `GROUP BY state` — when a state has zero rows, it emits no line at all. Downstream consumers (any awk/grep on the snapshot stream) will silently see the previous value carry forward.
- Concrete impact: my own first-pass timeline reported `wa=1` for the last 5h when in reality there were zero rows in state='active'. The dashboard and any future alerting that reads this stream will inherit the bug.
- Fix: in `scripts/soak/sql/snapshot.sql`, replace `GROUP BY state` with a LEFT JOIN against a fixed list of known states, so every snapshot emits a line per state (zero when empty). Same fix applies to per-queue depths.

### Category B — Operational blind spots (observability hardening)

**B1. `worker_stalest_seconds=0` is ambiguous.**
- The metric is `COALESCE(EXTRACT(EPOCH FROM (now() - min(last_heartbeat_at)))::int, 0)` with a `WHERE state IN ('active','idle')` filter. Zero live workers ⇒ `min` is NULL ⇒ result is 0 — indistinguishable from "all heartbeats are fresh".
- Fix: emit a separate `worker_live_count=` metric (already do) and have the dashboard render `stalest` as "N/A" when `worker_live_count=0`.

**B2. No log line explains "container exited, not restarted."**
- The api never knew the container had vanished. The sweeper observed the heartbeat going stale and transitioned the row to `disconnected` — *that* signal is correct — but there is no operator-level "fleet shrunk below N" alarm.
- Fix: add a snapshot metric `worker_fleet_shortfall = expected_replicas - live_workers` and a warning log line from the sweeper when it crosses zero.

**B3. Soak summary buries the headline.**
- `summary.txt` reports `Peak in-flight: 5` and `Last DLQ count: 130` — both technically true and both deeply misleading without context. The summary does not say "queue grew 60x" or "succeeded plateaued at hour 1".
- Fix: have the summary emit a few derived health indicators: enqueue rate vs success rate over the run, max queue depth, last live worker count, count of `no running containers` chaos events.

**B4. UI polling behavior was never exercised.**
- Add a dashboard-fetch synthetic to the soak harness (one HTTP poll per N seconds against the dashboard endpoints). Report stale-fetch count in the summary.

**B5. Worker resurrection is not observable — only worker death is.**
- During the run, "worker disappeared" was inferred from chaos-log `no running veyra-worker containers found` lines and the absence of `container=veyra-worker-*` in snapshots. There is no positive evidence stream for "a new worker appeared, with this container ID, this runtime ULID, this start time."
- Today's snapshot only emits one line per *currently* running worker container with cpu/mem. It does not emit: the docker container ID, the worker's runtime ULID ([[project-ephemeral-worker-runtimes]]), or a per-worker restart count derived from the deployment.
- Fix: extend `scripts/soak/snapshot.sh` (and the SQL in `scripts/soak/sql/snapshot.sql`) to record, per snapshot tick:
  - `worker_container:<service>=<container_id> started=<unix_ts>` — from `docker inspect`,
  - `worker_runtime:<workers.id>=<hostname> first_heartbeat_at=<ts> last_heartbeat_at=<ts>` — from the `workers` table,
  - `worker_generation_count=<n>` — number of distinct `workers.id` rows observed *for the same hostname* across the run (cheap with a window query).
- This is the observational complement to A1's chaos assertion. The chaos loop proves a worker resurrected by name; the snapshot stream proves the runtime ULID rotated and the heartbeat re-anchored. Both are needed; today we have neither.

### Category C — Future pressure signals (architecture indicators, NOT rewrite triggers)

**C1. Single api process = single scheduler / sweeper.**
- The sweeper docstring already notes this: "When that day arrives, wrap the tick in a Postgres advisory lock." Today's run does not yet demand it.

**C2. Snapshot SQL is fine for 60s/24h soaks but produces 388 KB of text for 6h.**
- At sustained 24h × 7d soaks this becomes annoying to grep. Not urgent; flagged for the day we move soak to a longer cadence.

**C3. Chaos rotation is deterministic.**
- Useful for reproducibility, but a deterministic rotation means we never test combinations (worker_kill *during* pg_restart, two worker_kills back-to-back). Future hardening: a randomized chaos mode behind an env flag.

## Validated positive signals (do not lose these)

Two results from this run are quietly large and worth recording as
validated invariants:

- **Retry pipeline stayed healthy under chaos** — `oldest_failed_due_lag_seconds` never exceeded 3s and `retry_due_now` peaked at 3, across an api restart and a postgres restart, while consumers existed. Jitter, scheduler tick, retry promotion, and reclaim composition all held. That is a non-trivial joint correctness result.
- **Memory was flat across 6h** for every Go service and for Postgres. With schedulers, sweepers, lease renewers, retry promoter, reconnect logic, chaos, and polling all running, no slope is a strong leak-absence signal.

These don't make A1/A2/A3 less urgent. They do mean: when the workers
*were* alive, the rest of the system did its job.

## What this report defers

Operator-control features — pause, drain, cancel, replay DLQ, audit
events — are the right next phase ([[project-phase-operator-semantics]]),
**but they must wait for A1/A2/A3 to be fixed and re-soaked**. Reasons:

- A1 means "deploys are not actually safe yet." Building drain on top of
  a fleet that doesn't respawn produces an unfalsifiable feature.
- A2 means there is no out-of-band reclaim path. Drain semantics rely on
  reliably transitioning leased jobs out of `running` — that's the same
  primitive A2 is missing.
- A3 means we cannot trust the metrics we'd use to verify drain worked.

Before any pause/drain implementation, the queue state machine
(`active`/`paused`/`draining`/`disabled`) must be specced in
`packages/queue-core/SPEC.md` ([[feedback-queue-state-machine-explicit]]),
and integration-test infrastructure against a real Postgres must be in
place ([[feedback-integration-tests-for-semantics]]).

## Suggested next actions, in order

The **next PR is A1 only — surgical scope.** A2 (reclaim), operator
controls, pause/drain, auth, and UI features are explicitly NOT in
scope. The slice below bundles everything required to *prove worker
resurrection semantics*, and nothing else:

| In scope | Out of scope (defer) |
|---|---|
| Restart-policy verification (`docker inspect`) | Reclaim redesign (A2) |
| Compose fix to pin restart semantics | Operator controls (pause/drain/cancel) |
| Chaos recovery assertion + `worker_recovery_seconds` metric | Replay DLQ, audit events |
| Generation observability (container ID, runtime ULID, generation count) | Auth, UI features |
| Snapshot zero-state fix (A3) | Anything else |

Execution order inside the slice:

1. **A1.1** — `docker inspect` a live worker under dev compose AND under the prod overlay. Capture `.HostConfig.RestartPolicy` and `.State`. This is the diagnosis step; it determines the fix.
2. **A1.2** — pin restart semantics. Likely drop the prod overlay's `deploy.restart_policy` (swarm-only) so the base `restart: unless-stopped` is the effective policy under `docker compose up`. Confirm with a follow-up `docker inspect`.
3. **A1.3** — add `scripts/chaos/expect-worker-resurrection.sh` and wire it into the chaos loop. After every `worker_term`/`worker_kill`, the script polls for a new container + a fresh `workers.id` row + its first heartbeat, then emits `worker_recovery_seconds=<n>`. A miss above the bound emits a hard failure line that the summary counts ([[feedback-chaos-must-assert-recovery]]).
4. **A3** — fix `snapshot.sql` (zero-state lines, LEFT JOIN against a fixed state list). Audit other downstream consumers for the same "absent line = stale carry" assumption.
5. **B5** — extend `snapshot.sh` + `snapshot.sql` with container ID + `started_at`, `workers.id` + hostname + first/last heartbeat, and a per-hostname `worker_generation_count` window query.
6. **Targeted resurrection soak (30–45 min)** — only `worker_kill` chaos, no api/pg restart, no DB chaos. Pass condition: every kill is followed by a `worker_recovery_seconds` line within bound; the summary explicitly reports pass/fail on that single invariant. ([[feedback-targeted-soak-before-burner]])
7. **24h burner soak** — only after the targeted soak passes. Wire in B4's dashboard poller. Append the next report to this file.
8. *Then, and only then* — open the reclaim-as-shared-primitive SPEC entry ([[feedback-shared-semantics-shared-primitive]]); then queue state machine; then pause/drain/cancel/replay/audit.

---

# Soak report — 2026-05-28 (A1 validation, partial burner)

## Headline

A1.2 (compose restart policy) and A1.3 (chaos kill methodology + bounded
recovery assertion) **validated end-to-end.** Across 10 observed worker
chaos events covering both signal types and all three worker slots:

- **10 / 10 recoveries succeeded.**
- `worker_recovery_seconds` distribution: min=0s, max=2s, mean=1.4s — bound was 30s, so **15× headroom**.
- `RestartCount` on `veyra-worker-1` climbed cleanly 0→1→2→3→4 across the five events that targeted it; every restart stuck.

The single most important finding of run 20260526T122313Z — "workers
silently disappear and never come back" — is gone. The compose policy
fires, the chaos script triggers a daemon-natural exit (not a manually-
stopped flag), and the assertion measures recovery within ~1s.

## Run parameters

| Knob | Value |
|---|---|
| Stack | prod overlay (nginx + api + worker×3 + postgres) under base `restart: unless-stopped` (A1.2) |
| Started | ~2026-05-28T08:57Z |
| Stopped | manually, ~2026-05-28T11:50Z (after 10 worker chaos events; user declared A1 validated) |
| Effective duration | ~2h 53m (target was `SOAK_DURATION_SECONDS=86400`; stopped early on purpose) |
| Chaos rotation | full default — `worker_term → worker_kill → api_restart → pg_restart` every 600s |
| Chaos events observed | 5 worker_term, 5 worker_kill, plus implicit api_restart / pg_restart events between them (not captured by the grep above) |
| Snapshot interval | 60s (default) |
| Logs | `soak-logs/2026052*T*Z-{enqueue,chaos,snapshot,summary}.{log,txt}` |

Note on scope: this was intended to be a targeted 35-min resurrection
soak per [[feedback-targeted-soak-before-burner]]. In practice the soak
was launched with default env vars (24h duration, all 4 chaos kinds, 600s
interval) and stopped early once A1 validation was unambiguous. Net
effect: targeted soak + partial burner in one. The discipline rule still
applies for future post-fix validations — set `CHAOS_KINDS` and
`SOAK_DURATION_SECONDS` explicitly so the soak's scope matches the fix.

## Recovery detail

| Time (UTC) | Kind | Target | Baseline RC | recovery_seconds |
|---|---|---|---|---|
| 09:00:02 | worker_term | veyra-worker-1 | 0 | 2 |
| 09:10:04 | worker_kill | veyra-worker-1 | 1 | 1 |
| 09:40:06 | worker_term | veyra-worker-2 | 0 | 1 |
| 09:50:07 | worker_kill | veyra-worker-3 | 0 | 2 |
| 10:20:19 | worker_term | veyra-worker-1 | 2 | 2 |
| 10:30:21 | worker_kill | veyra-worker-3 | 1 | 1 |
| 11:00:23 | worker_term | veyra-worker-2 | 1 | 0 |
| 11:10:23 | worker_kill | veyra-worker-2 | 2 | 2 |
| 11:40:25 | worker_term | veyra-worker-1 | 3 | 2 |
| 11:50:27 | worker_kill | veyra-worker-1 | 4 | 1 |

Worker coverage: w1 ×5, w2 ×3, w3 ×2 (random selection via `shuf`; reasonable spread).

## What this run does NOT cover

Stopped early on purpose, so the following remain unvalidated for the
next burner:

- **api/pg restart recovery under live load.** The chaos rotation fired
  these events between the worker kills (visible as ~30-min gaps in the
  recovery log), but they don't have a recovery assertion of their own
  yet. They didn't break anything observable, but "didn't break"
  isn't the same as "verified bounded recovery". Out-of-scope follow-up.
- **A1's broader question (the 2026-05-26 finding):** does the queue
  stay healthy across many hours of repeated worker churn + DB restarts?
  Not answered here — we stopped at ~3h. Belongs to the post-A2 burner.
- **A2.** Reclaim still lives only inside dequeue; an api outage during
  which workers also crash would still leave `running` rows stranded.
  This is the next thing to fix and the reason for stopping the burner
  here rather than running it through.

## Next action

Per the run-2026-05-26 plan, the next item is A2: open the SPEC entry
for reclaim as a shared primitive in `packages/queue-core/SPEC.md`
([[feedback-shared-semantics-shared-primitive]],
[[feedback-queue-state-machine-explicit]],
[[feedback-queue-spec-first]]). Implementation follows the SPEC, not
the other way around. After A2 lands and has its own integration tests
([[feedback-integration-tests-for-semantics]]), run the deferred 24h
burner with B4's dashboard poller wired in and append its report below.

**Update 2026-05-28:** A2 SPEC landed. `packages/queue-core/SPEC.md` §5
is now a top-level Reclaim primitive with two invocation sites
(`InlineClaim` dequeue, `TickRequeue` api-side periodic), explicit
idempotency invariant (§5.7), post-lock revalidation contract (§5.4
+ `ReclaimOutcomeStale`), orthogonality vs retry scheduler (§5.8),
and the post-A2 "fleet collapse → queue self-heals" integration
scenario (§5.13). Dequeue §1.5 is now a 15-line stub.

**Implementation + integration test passed 2026-05-28:**

- `packages/queue-core/reclaim.go` — the primitive (340 lines), with
  `ReclaimMode {InlineClaim, TickRequeue}`, `ReclaimOutcome
  {Claimed, Requeued, DeadLettered, Stale}`, and §5.4's single
  conditional-UPDATE recheck (selection is advisory, post-lock is
  authoritative).
- `apps/api/internal/reclaim/driver.go` — the tick driver (260
  lines), running 10s interval / 100 row LIMIT default, per-row
  SAVEPOINT, emitting `queue.reclaim.tick` per tick + per-row
  `queue.reclaim.row.*` events.
- `packages/queue-core/repository.go` `ClaimNextJob` — refactored to
  invoke `Reclaim(InlineClaim)` instead of inlining the reclaim
  block. Selection predicate includes the `reclaim_grace` window
  (default 10s).
- `apps/api/cmd/api/main.go` — `reclaim.Driver` started as a
  goroutine alongside the sweeper and retry scheduler.
- `packages/queue-core/testsupport/postgres.go` — testcontainers-go
  harness (build-tagged `integration` so production builds skip it).
- `packages/queue-core/reclaim_integration_test.go` — the
  fleet-collapse → self-heals scenario. **Passed in 51.6s against a
  real Postgres on 2026-05-28**, validating: gen1 claims 12 jobs →
  fleet "dies" → tick reclaim closes 12 attempts with
  `outcome='lease_lost'` and requeues without incrementing
  `attempt` → gen2 claims with `attempt=2` → all 12 acked
  successfully. Explicit execution-uniqueness assertion (per-job
  `attempt[n].ended_at <= attempt[n+1].started_at`) held, and the
  schema-level `(job_id, attempt_number)` uniqueness check passed.

**Next step — task #17 (targeted reclaim soak), THEN real
workloads.** Per the [[project-phase-real-workloads]] memory, after
#17 passes its exit criteria, Veyra exits engine-refinement and
enters real-workload validation (webhook delivery, scheduled jobs,
Snapify async). Operator semantics (pause / drain / cancel / replay
/ audit) are deferred until real workloads demonstrate concrete
need.

## Run #17 — Targeted reclaim soak

**Purpose:** validate the reclaim primitive + tick driver under
sustained fleet-collapse / resurrection cycles, before any further
infrastructure work. NOT a broad burner — focused on reclaim
correctness only.

**Suggested invocation** (40 minutes, fleet collapse every 2 min):

```bash
SOAK_DURATION_SECONDS=2400 \
CHAOS_INTERVAL=120 \
CHAOS_KINDS="worker_fleet_collapse" \
ENQUEUE_INTERVAL=15 \
ENQUEUE_BURST=5 \
SNAPSHOT_INTERVAL=30 \
DOCKER_COMPOSE_FILES="-f deployments/compose/docker-compose.yml -f deployments/compose/docker-compose.prod.yml" \
bash scripts/soak/run.sh
```

Yields ~20 fleet-collapse events, ~800 enqueued jobs, ~80 snapshot
ticks.

**Exit criteria — all six MUST hold for the soak to pass:**

| # | Criterion | Verification |
|---|---|---|
| 1 | **Zero fleet-recovery failures** | `grep -c 'chaos\.fleet\.recovery\.failed' soak-logs/$RUN-chaos.log` → `0` |
| 2 | **Zero stuck running rows at end** | Last 5 snapshot ticks must all show `jobs_with_expired_lease=0`. (`tail` the snapshot log; the metric is per-tick.) |
| 3 | **Bounded reclaim recovery time** | `grep -oE 'worker_recovery_seconds=[0-9]+' soak-logs/$RUN-chaos.log \| awk -F= '{print $2}' \| sort -n \| tail -1` → < `30` |
| 4 | **Reclaim tick stable throughout** | The summary's "Reclaim tick: rows requeued (total)" must be > 0. No gap >120s between successive `queue.reclaim.tick` events in the api logs. |
| 5 | **No execution-uniqueness violations** | Post-soak SQL: `SELECT job_id, attempt_number, COUNT(*) FROM job_attempts GROUP BY job_id, attempt_number HAVING COUNT(*) > 1` → empty result set |
| 6 | **Attempt-number continuity** | Post-soak SQL: `WITH t AS (SELECT job_id, attempt_number, lag(attempt_number) OVER (PARTITION BY job_id ORDER BY attempt_number) AS prev FROM job_attempts) SELECT * FROM t WHERE prev IS NOT NULL AND attempt_number <> prev + 1` → empty result set (no gaps) |

If all six hold, A2 is operationally validated, deep
reclaim/queue-core work is frozen, and the next deliverable is a
real workload integration ([[project-phase-real-workloads]]).

If any fail, dig — do NOT proceed to real workloads on top of an
unverified reclaim layer.

### Run #17 — results (PASS, all six)

Run #17 executed in two parts because the first run exposed an
instrumentation bug (not an engine bug) that silently dropped two of
the six measurements.

**Part 1 — `20260528T135813Z`** (40 min, 19 fleet collapses). The
reclaim engine passed decisively: `jobs_with_expired_lease=0` across
all 74 snapshot ticks (#2), tick stable through every collapse with
28 lease-lost reclaims and DLQ flat at 218 — zero spurious dead-letters
(#4), zero duplicate `(job_id, attempt_number)` across 18,165 attempts
(#5), zero attempt-number gaps (#6). 14,137 jobs succeeded.

But criteria **#1 and #3 recorded no data**: `expect-fleet-resurrection.sh`
crashed on every collapse with `line 50: RECOVERED: unbound variable`.
Root cause: bash (confirmed through 5.2.37) errors on `${#assoc[@]}`
when the associative array is empty under `set -u` — which is the
recovery loop's initial state. The assertion no-op'd before polling.
Indirect evidence the fleet *did* recover each cycle: per-worker
`baseline_restart_count` climbed monotonically `0 → 18` across the 19
collapses with no resets. But per the chaos-recovery discipline
(a bounded recovery assertion is mandatory; "it crashed cleanly" is
not a pass), #1 and #3 could not be certified on indirect evidence.

**Fix:** `expect-fleet-resurrection.sh` now tracks recovered count in a
plain integer (`RECOVERED_COUNT`) instead of `${#RECOVERED[@]}`,
sidestepping the bash bug. Two latent `scripts/soak/run.sh` summary
bugs were fixed alongside: (a) `grep -c ... || echo 0` emitted `"0\n0"`
on a legitimately-zero counter and crashed the summary with "integer
expression expected" (the run's non-zero exit); (b) the fleet-success
grep `'…summary outcome=success'` never matched because the line
carries `recovered=N expected=N` between `summary` and `outcome=`.

**Part 2 — confirmation soak `20260529T042512Z`** (15 min, 9 fleet
collapses, fixed instrumentation). Captured the two missing criteria
and re-confirmed the other four under fresh load:

| # | Criterion | Result |
|---|---|---|
| 1 | Zero fleet-recovery failures | **PASS** — 9/9 collapses `outcome=success`, 0 failed |
| 2 | Zero stuck running rows at end | **PASS** — final tick `jobs_with_expired_lease=0` (one expected grace-window blip of 2 mid-collapse, reclaimed by next tick) |
| 3 | Bounded reclaim recovery time | **PASS** — max `worker_recovery_seconds = 2` (bound 30) |
| 4 | Reclaim tick stable throughout | **PASS** — 45 lease-lost reclaims executed; expired-lease returned to 0 each cycle |
| 5 | No execution-uniqueness violations | **PASS** — 0 duplicate `(job_id, attempt_number)` |
| 6 | Attempt-number continuity | **PASS** — 0 gaps |

**Surfaced (not a bug — confirms §5.6):** 7 new dead-letters during the
confirmation run. 5+ were genuine handler-failure budget exhaustion
(final attempt `outcome=failed`). One — `01KSRZTT291P796AX2RJ323D5Z` —
failed attempts 1 & 2, then lost its lease to a fleet collapse on
attempt 3 (== max_attempts) and was dead-lettered with final outcome
`lease_lost`. This is the documented §5.6 budget-exhausted-on-reclaim
path: a lease lost at the budget ceiling dead-letters rather than
re-running forever (poison-pill guard). The soak exercised and
confirmed this path is reachable and bounded; execution uniqueness held
(no duplicate run of the orphaned attempt).

**Verdict: A2 is operationally validated.** Deep reclaim/queue-core
semantic work is frozen. Next deliverable: the first real workload —
outbound webhook delivery ([[project-phase-real-workloads]]).

---

# Workload exercise — 2026-06-03 (W6: first real-workload failure-mode validation)

## Headline

The first validation driven by a **real workload** (the `http_request`
handler) rather than the `noop` simulator. All six failure modes were
exercised end-to-end against the in-tree unstable receiver, on the live
base+prod stack. **The queue engine behaved correctly in every scenario;
no SPEC mismatches were found.** The evidence justified exactly one
forward decision: retryable-vs-permanent failure classification is worth
specifying (now `packages/queue-core/SPEC.md` §7, PROPOSED).

This is the payoff of [[project-phase-real-workloads]]: real work created
real failure pressure that exposed the *right* next decision instead of a
synthetic one.

## Run parameters

- Stack: `docker-compose.yml` + `docker-compose.prod.yml` (nginx front
  door, 3 worker replicas, postgres loopback-bound) + the opt-in
  `docker-compose.receiver.yml`. API W4 changes rebuilt and confirmed
  live (`?handler=` narrows: all=14896, `http_request`=20,
  `__nonexistent__`=0 — a pre-W4 api returns all for an unknown param).
- Handler under test: `http_request` (W2/W2.1). Workers on `queue=default`.
  `VEYRA_WORKER_FAILURE_PERCENT` affects only `noop`, so http_request
  outcomes are determined solely by the receiver's response.
- Engine timing (all default): lease 30s, reclaim grace 10s, reclaim tick
  10s, retry scheduler tick 5s. Per-job backoff overridden to fixed 2s so
  retry→DLQ completes in seconds; default exponential base=30s is too slow
  for tight iteration.
- Receiver shaping via per-request query params (`?bucket=`, `?hang=`,
  `?delayMs=`, closed port for refusal).

## Scenarios and evidence

| # | Scenario | Drive | Expected | Actual | Transitions | Retry | DLQ |
|---|---|---|---|---|---|---|---|
| 1 | Success | `?bucket=2xx` | succeed attempt 1 | ✅ | queued→running→**succeeded** | — | no |
| 2 | HTTP 4xx | `?bucket=4xx`, max=2 | retry→DLQ | ✅ | failed→queued→running→**dead_lettered** | http_4xx ×2 | yes |
| 3a | HTTP 5xx persistent | `?bucket=5xx`, max=3 | retry→DLQ | ✅ | 3× http_5xx → **dead_lettered** (across 2 workers) | http_5xx ×3 | yes |
| 3b | HTTP 5xx → recovery | weighted mix, max=5 | transient 5xx then succeed | ✅ | `http_5xx→succeeded`; one job `4× http_5xx→succeeded` (attempt 5) | yes | no |
| 4 | Timeout | `?hang=1`, timeoutSeconds=2, max=2 | classify timeout, retry→DLQ | ✅ | 2× timeout (dur=2s each) → **dead_lettered** | timeout ×2 | yes |
| 5 | Connection failure | closed port `:9999`, max=2 | classify, retry→DLQ | ✅ | 2× connection_refused → **dead_lettered** | conn_refused ×2 | yes |
| 6 | Worker death mid-flight | `kill -9` the owning worker | lease expire→reclaim→re-exec elsewhere | ✅ | attempt1 **lease_lost** (dur=40s, dead worker) → attempt2 **succeeded** (different worker) | reclaim requeue | no |

Representative attempt histories (from `job_attempts`):

```
S2 4xx          : 1 http_4xx failed ; 2 http_4xx failed → dead_lettered
S3a 5xx persist : 1 http_5xx ; 2 http_5xx ; 3 http_5xx → dead_lettered (workers rotated)
S3b recovery    : 01KT6B7T195S… : 1 http_5xx failed ; 2 succeeded
                  01KT6B7T24V4… : 1-4 http_5xx failed ; 5 succeeded (recovered at the ceiling)
S4 timeout      : 1 timeout (2s) ; 2 timeout (2s) → dead_lettered
S5 conn refused : 1 connection_refused ; 2 connection_refused → dead_lettered
S6 worker death : 1 lease_lost (worker 01KT66K8A7…, 40s) ; 2 succeeded (worker 01KT66K8676…)
```

Scenario 6 detail: the owning worker was hard-killed (SIGKILL of the
worker PID — NOT `docker kill`, NOT PID 1/tini) mid-request. Its lease
expired (30s) + grace (10s) + tick (10s) → reclaim requeued the row →
attempt 2 ran on a **different** worker and succeeded. The attempt number
did **not** increment on reclaim requeue (§5.5.2 holds); attempt 1 closed
with `outcome=lease_lost` (§5.4). The killed container restarted with a
**new ULID**; the api worker sweeper (`apps/api/internal/workers/sweeper.go`)
flipped the dead ULID to `disconnected` (correct — a SIGKILL'd worker
cannot self-deregister).

> Tooling note: `pkill -x worker` / `pgrep -x worker` do **not** match the
> Go worker process in the minimal runtime image (returns no match despite
> `ps` showing `comm=worker`). Kill by PID instead. The earlier
> "`pkill <bin>`" chaos guidance is unreliable here; verify the kill landed
> (container uptime reset / new ULID) before trusting a death scenario.

## W4 aggregate reporting (validated on real data)

`scripts/soak/sql/snapshot.sql` (http_request slice) after the run:

```
jobs_by_handler:http_request:succeeded=26   dead_lettered=8   (queued/running/failed/cancelled=0)
http_request_error: http_4xx=3  http_5xx=1  timeout=2  connection_refused=2
                    connection=0  dns=0  http_3xx=0  http_other=0  invalid_payload=0  unlisted=0
attempts_lease_lost=47   (incremented by the scenario-6 reclaim)
```

`scripts/sql/queue_state.sql` §5 cleanly separated `http_request` failures
by class from the `noop`/`soak.tick` simulated noise. `unlisted=0` confirms
every emitted error class is enumerated by the fixed set.

## Findings

- **F1 — Engine correct, no SPEC mismatch.** Retry scheduler, reclaim,
  DLQ, and worker-crash recovery all behaved per SPEC across all six
  scenarios. Nothing to fix in the engine.
- **F2 — `jobs.error` is durable on a recovered job (UI concern, not a
  queue-semantic one).** A job that fails then succeeds keeps its last
  `error` (e.g. `http_5xx`) on the row; `MarkJobSucceeded` does not clear
  it. **Decision: keep it** — preserve historical failure context in
  storage. Fixed display-only: the W5 job-detail view now labels it
  "Last failure (recovered)" on succeeded jobs.
- **F3 — Retryable-vs-permanent is now evidence-backed (drives §7).**
  `http_4xx` (non-408/429) and `invalid_payload` re-failed identically on
  every retry (no value); `http_5xx`, `timeout`, `connection_refused`, and
  lease-loss all recovered (clear value). This is the basis for the
  `packages/queue-core/SPEC.md` §7 proposal. `dns` is treated as retryable
  (it can flap); `http_4xx` must be classified per status code (408/429
  retryable), not as one bucket.

## Categorized findings

- **Category A (immediate bugs):** none.
- **Category B (observability):** F2 (handled — W5 display fix shipped).
- **Category C (future pressure signal):** F3 — specified as §7 (PROPOSED),
  awaiting review. No implementation until reviewed.

## Verdict

The first real workload is operationally validated end-to-end through the
live retry/reclaim/DLQ pipeline. The engine needs no changes. The single
forward decision — retryable-vs-permanent classification — is captured
spec-first in §7 and is the only sanctioned next step, pending review.
