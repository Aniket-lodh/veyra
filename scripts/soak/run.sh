#!/usr/bin/env bash
# run.sh — long-running soak harness.
#
# Three concurrent loops against the running compose stack:
#
#   1. enqueue loop    — POSTs N jobs every ENQUEUE_INTERVAL seconds
#   2. chaos loop      — kills a random worker every CHAOS_INTERVAL seconds
#   3. snapshot loop   — appends one snapshot to the logfile every
#                        SNAPSHOT_INTERVAL seconds
#
# Why all three together: a soak harness without chaos is just a stress
# test; chaos without snapshots is just "did anything explode visibly."
# Drift detection requires the time series.
#
# Run on the host (NOT in a container — it docker-compose-execs from
# outside):
#
#   ./scripts/soak/run.sh
#
# Knobs (env):
#
#   SOAK_DURATION_SECONDS    total run length (default 86400 = 24h)
#   ENQUEUE_INTERVAL         seconds between enqueue bursts (default 30)
#   ENQUEUE_BURST            jobs per burst (default 5)
#   CHAOS_INTERVAL           seconds between chaos events (default 600 = 10m)
#                            set to 0 to disable chaos
#   CHAOS_KINDS              space-separated rotation of chaos actions, run
#                            round-robin. Available kinds:
#                              - worker_term         (kill one random worker, SIGTERM)
#                              - worker_kill         (kill one random worker, SIGKILL)
#                              - worker_fleet_collapse (kill ALL workers simultaneously
#                                via in-container pkill — the fleet-collapse scenario
#                                that exercises tick reclaim under "zero workers" load)
#                              - api_restart         (docker compose restart api)
#                              - pg_restart          (docker compose restart postgres)
#                            Default: "worker_term worker_kill api_restart pg_restart".
#                            For a targeted resurrection soak: "worker_kill" or
#                            "worker_term worker_kill". For the post-A2 reclaim soak:
#                            "worker_fleet_collapse". See the
#                            feedback-targeted-soak-before-burner memory.
#   SNAPSHOT_INTERVAL        seconds between snapshots (default 60)
#   VEYRA_API_URL            api base url (default http://localhost:8008)
#                            under the prod overlay nginx fronts the api at
#                            http://127.0.0.1:8088
#   DOCKER_COMPOSE_FILES     compose file flags for chaos + snapshot (default
#                            -f deployments/compose/docker-compose.yml).
#                            For the prod overlay pass both:
#                              "-f deployments/compose/docker-compose.yml \
#                               -f deployments/compose/docker-compose.prod.yml"
#   LOG_DIR                  output directory (default ./soak-logs)
#
# Chaos rotation. The chaos loop cycles deterministically through four
# actions every CHAOS_INTERVAL seconds, in this order:
#   1. worker SIGTERM     (graceful — exercises the clean-shutdown path)
#   2. worker SIGKILL     (hard crash — exercises the stale-worker sweeper)
#   3. api restart        (exercises scheduler recovery + worker reconnect)
#   4. postgres restart   (exercises pgx pool reconnect + lease durability)
#
# Cleanly stops on Ctrl-C (SIGINT) or SIGTERM. The summary line at the end
# tells you what was actually generated.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SOAK_DURATION_SECONDS="${SOAK_DURATION_SECONDS:-86400}"
ENQUEUE_INTERVAL="${ENQUEUE_INTERVAL:-30}"
ENQUEUE_BURST="${ENQUEUE_BURST:-5}"
CHAOS_INTERVAL="${CHAOS_INTERVAL:-600}"
CHAOS_KINDS="${CHAOS_KINDS:-worker_term worker_kill api_restart pg_restart}"
SNAPSHOT_INTERVAL="${SNAPSHOT_INTERVAL:-60}"
# Parse CHAOS_KINDS into an array up front; the loop dispatches into
# chaos_action_<kind> by index. Unknown kinds emit a single warning line
# at startup so a typo doesn't silently no-op the entire chaos loop.
read -ra CHAOS_ACTIONS <<< "$CHAOS_KINDS"
VEYRA_API_URL="${VEYRA_API_URL:-http://localhost:8008}"
DOCKER_COMPOSE_FILES="${DOCKER_COMPOSE_FILES:--f $REPO_ROOT/deployments/compose/docker-compose.yml}"
LOG_DIR="${LOG_DIR:-$REPO_ROOT/soak-logs}"
export DOCKER_COMPOSE_FILES  # snapshot.sh picks this up too

mkdir -p "$LOG_DIR"
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT_LOG="$LOG_DIR/$RUN_ID-snapshot.log"
ENQUEUE_LOG="$LOG_DIR/$RUN_ID-enqueue.log"
CHAOS_LOG="$LOG_DIR/$RUN_ID-chaos.log"
SUMMARY="$LOG_DIR/$RUN_ID-summary.txt"

echo "Soak run $RUN_ID"
echo "  duration  : ${SOAK_DURATION_SECONDS}s"
echo "  enqueue   : ${ENQUEUE_BURST} jobs every ${ENQUEUE_INTERVAL}s → $ENQUEUE_LOG"
echo "  chaos     : every ${CHAOS_INTERVAL}s (0=off), kinds=[${CHAOS_KINDS}] → $CHAOS_LOG"
echo "  snapshot  : every ${SNAPSHOT_INTERVAL}s → $SNAPSHOT_LOG"
echo

# --- Child loop pids; cleaned up on exit -------------------------------------
PIDS=()

cleanup() {
    echo
    echo "[$(date -u +%H:%M:%SZ)] soak: stopping background loops…"
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true

    {
        echo "Soak run $RUN_ID summary"
        echo "  ended at        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "  snapshot lines  : $(wc -l < "$SNAPSHOT_LOG" 2>/dev/null || echo 0)"
        echo "  enqueue lines   : $(wc -l < "$ENQUEUE_LOG"  2>/dev/null || echo 0)"
        echo "  chaos lines     : $(wc -l < "$CHAOS_LOG"    2>/dev/null || echo 0)"
        echo
        echo "Last DLQ count:"
        local dlq_line
        dlq_line=$(grep '^ts=.* jobs_total:dead_lettered=' "$SNAPSHOT_LOG" 2>/dev/null | tail -1)
        if [ -n "$dlq_line" ]; then
            echo "  $dlq_line"
        else
            # Zero dead-lettered rows ⇒ the GROUP BY emits nothing for
            # that status. That is GOOD news, not a missing snapshot.
            if grep -q '^ts=.* jobs_total:' "$SNAPSHOT_LOG" 2>/dev/null; then
                echo "  0 (no dead-lettered jobs across the run)"
            else
                echo "  (no snapshot taken)"
            fi
        fi
        echo
        echo "Peak in-flight:"
        grep '^ts=.* jobs_in_flight=' "$SNAPSHOT_LOG" 2>/dev/null \
            | awk -F= '{print $NF}' | sort -n | tail -1 \
            | xargs -I{} echo "  {}"
        echo
        # Worker recovery — the headline invariant for chaos. Count of
        # successful recoveries, min/max recovery_seconds, and (loudly)
        # the count of recovery failures. A failing soak surfaces here,
        # not 9,000 lines deep in the snapshot stream.
        echo "Worker recovery:"
        local rec_ok rec_fail rec_min rec_max
        # NB: `grep -c` prints "0" AND exits 1 on no-match, so the old
        # `|| echo 0` appended a SECOND zero → "0\n0", which then blew up
        # `[ -gt ]` with "integer expression expected" and exited the
        # whole summary non-zero. Capture grep's stdout, and only on its
        # nonzero exit overwrite with a clean single 0.
        rec_ok=$(grep -c 'worker_recovery_seconds=' "$CHAOS_LOG" 2>/dev/null) || rec_ok=0
        rec_fail=$(grep -c 'chaos.recovery.failed' "$CHAOS_LOG" 2>/dev/null) || rec_fail=0
        if [ "$rec_ok" -gt 0 ]; then
            rec_min=$(grep -oE 'worker_recovery_seconds=[0-9]+' "$CHAOS_LOG" \
                | awk -F= '{print $2}' | sort -n | head -1)
            rec_max=$(grep -oE 'worker_recovery_seconds=[0-9]+' "$CHAOS_LOG" \
                | awk -F= '{print $2}' | sort -n | tail -1)
            echo "  successful : $rec_ok (min=${rec_min}s max=${rec_max}s)"
        else
            echo "  successful : 0"
        fi
        if [ "$rec_fail" -gt 0 ]; then
            echo "  FAILED     : $rec_fail (search CHAOS_LOG for 'chaos.recovery.failed')"
        else
            echo "  failed     : 0"
        fi
        echo
        # Fleet-collapse summary (only meaningful when CHAOS_KINDS includes
        # worker_fleet_collapse). The per-fleet recovery counts and the
        # per-fleet max recovery time both surface here so the headline
        # invariant — "every fleet collapse recovered within bound" — is
        # one line, not buried in a 20MB chaos log.
        local fleet_ok fleet_fail fleet_max
        # The summary line carries `recovered=N expected=N` BETWEEN
        # "summary" and "outcome=", so the pattern must allow fields in
        # between — the old adjacent-match counted zero even on success.
        # Same grep -c double-zero fix as the worker-recovery block above.
        fleet_ok=$(grep -cE 'chaos\.fleet\.recovery\.summary .*outcome=success' "$CHAOS_LOG" 2>/dev/null) || fleet_ok=0
        fleet_fail=$(grep -cE 'chaos\.fleet\.recovery\.summary .*outcome=failed' "$CHAOS_LOG" 2>/dev/null) || fleet_fail=0
        if [ "$fleet_ok" -gt 0 ] || [ "$fleet_fail" -gt 0 ]; then
            echo "Fleet collapse:"
            echo "  successful : $fleet_ok"
            if [ "$fleet_fail" -gt 0 ]; then
                echo "  FAILED     : $fleet_fail (search CHAOS_LOG for 'chaos.fleet.recovery.failed')"
            else
                echo "  failed     : 0"
            fi
            if [ "$fleet_ok" -gt 0 ]; then
                fleet_max=$(grep -oE 'chaos\.fleet\.recovery\.summary[^|]*max_recovery_seconds=[0-9]+' "$CHAOS_LOG" \
                    | grep -oE 'max_recovery_seconds=[0-9]+' | awk -F= '{print $2}' | sort -n | tail -1)
                echo "  max worker recovery (s) : ${fleet_max:-0}"
            fi
        fi
        echo
        # Reclaim tick health. If the tick is alive, every CHAOS_INTERVAL
        # window should contain multiple `queue.reclaim.tick` lines from
        # the api logs. We do NOT grep the api logs here (that's a soak-
        # external concern); instead we surface the count of tick events
        # observed in the snapshot stream — the snapshot harness captures
        # them via emit_recent_errors's log scan. Future enhancement: tail
        # the api container directly.
        local reclaim_requeued
        reclaim_requeued=$(grep -oE 'queue\.reclaim\.tick[^"]*reclaimedRequeued=[0-9]+' "$SNAPSHOT_LOG" 2>/dev/null \
            | grep -oE 'reclaimedRequeued=[0-9]+' | awk -F= '{s+=$2} END {print s+0}')
        echo "Reclaim tick (from snapshot stream, may undercount):"
        echo "  rows requeued (total) : ${reclaim_requeued:-0}"
    } > "$SUMMARY"
    cat "$SUMMARY"
}
trap cleanup EXIT INT TERM

# --- Enqueue loop ------------------------------------------------------------
enqueue_loop() {
    local i=0
    while true; do
        for _ in $(seq 1 "$ENQUEUE_BURST"); do
            i=$((i + 1))
            local resp
            resp=$(curl -fsS -X POST "$VEYRA_API_URL/jobs" \
                -H 'Content-Type: application/json' \
                -d "{\"handler\":\"soak.tick\",\"queue\":\"default\",\"payload\":{\"i\":$i,\"runId\":\"$RUN_ID\"}}" \
                2>&1 || true)
            echo "[$(date -u +%H:%M:%SZ)] enqueue#$i $resp" >> "$ENQUEUE_LOG"
        done
        sleep "$ENQUEUE_INTERVAL"
    done
}

# --- Chaos loop --------------------------------------------------------------
#
# Cycles deterministically: SIGTERM → SIGKILL → api restart → postgres restart.
# Round-robin (not random) so an operator looking at the chaos log can predict
# what's next and correlate snapshot dips with the right action. Per-action
# logs are tagged `chaos.kind=<tag>` so grep can extract per-action time series.
#
# Worker-kill actions are paired with a bounded recovery assertion that emits
# `worker_recovery_seconds=<n>` on success and `chaos.recovery.failed ...` on
# timeout — chaos that proves death without proving recovery is a half-test.
# See docs/SOAK_REPORT.md run 20260526T122313Z, finding A1.

# Kill-then-assert helper. `signal` is SIGTERM or SIGKILL; `kind` is the log
# label (worker_term / worker_kill). Both the kill line and the recovery
# assertion line are appended to CHAOS_LOG, each prefixed with `chaos.kind=`
# so per-action time series remain greppable.
chaos_kill_with_assertion() {
    local signal="$1"
    local kind="$2"
    local ts
    ts=$(date -u +%H:%M:%SZ)

    # `|| true` so a missing target / no-match exit doesn't bubble up under
    # set -e and kill the chaos loop. The error line itself is already in
    # the captured output.
    local kill_out
    kill_out=$(bash "$REPO_ROOT/scripts/chaos/kill-random-worker.sh" "$signal" 2>&1) || true
    echo "[$ts] chaos.kind=$kind $kill_out" >> "$CHAOS_LOG"

    # Parse the structured fields. If any is missing the kill failed and
    # there is nothing to assert against. baseline_rc must come from the
    # kill script — capturing it in the assertion is racy under
    # `unless-stopped` (the daemon restarts faster than the first
    # `docker inspect` lands).
    local target killed_at baseline_rc
    target=$(echo "$kill_out" | grep -oE 'chaos\.target=[^ ]+' | head -1 | cut -d= -f2 || true)
    killed_at=$(echo "$kill_out" | grep -oE 'chaos\.killed_at=[0-9]+' | head -1 | cut -d= -f2 || true)
    baseline_rc=$(echo "$kill_out" | grep -oE 'chaos\.baseline_restart_count=[0-9]+' | head -1 | cut -d= -f2 || true)
    if [[ -z "$target" || -z "$killed_at" || -z "$baseline_rc" ]]; then
        echo "[$(date -u +%H:%M:%SZ)] chaos.kind=$kind chaos.assertion.skipped reason=missing_fields" >> "$CHAOS_LOG"
        return
    fi

    local recovery_out
    recovery_out=$(bash "$REPO_ROOT/scripts/chaos/expect-worker-resurrection.sh" \
                        "$target" "$killed_at" "$baseline_rc" 2>&1) || true
    echo "[$(date -u +%H:%M:%SZ)] chaos.kind=$kind $recovery_out" >> "$CHAOS_LOG"
}

chaos_action_worker_term() { chaos_kill_with_assertion SIGTERM worker_term; }
chaos_action_worker_kill() { chaos_kill_with_assertion SIGKILL worker_kill; }

# Fleet-collapse chaos action — kill ALL workers simultaneously and
# assert every one of them comes back within the bound. The reclaim
# tick is expected to requeue any in-flight rows during the gap. See
# SOAK_REPORT.md A2 / project-phase-real-workloads memory for the
# motivating reclaim-soak scenario.
chaos_action_worker_fleet_collapse() {
    local ts; ts=$(date -u +%H:%M:%SZ)
    local kill_out
    kill_out=$(bash "$REPO_ROOT/scripts/chaos/kill-all-workers.sh" SIGKILL 2>&1) || true
    # Tag every line of the multi-line kill output with the chaos.kind
    # prefix so post-soak grep cleanly extracts per-action time series.
    while IFS= read -r line; do
        echo "[$ts] chaos.kind=worker_fleet_collapse $line" >> "$CHAOS_LOG"
    done <<< "$kill_out"

    # The recovery assertion reads the kill output from stdin so it knows
    # which containers to poll and what their pre-kill baselines were.
    local recovery_out
    recovery_out=$(echo "$kill_out" | bash "$REPO_ROOT/scripts/chaos/expect-fleet-resurrection.sh" 60 2>&1) || true
    local rts; rts=$(date -u +%H:%M:%SZ)
    while IFS= read -r line; do
        echo "[$rts] chaos.kind=worker_fleet_collapse $line" >> "$CHAOS_LOG"
    done <<< "$recovery_out"
}
chaos_action_api_restart() {
    echo "[$(date -u +%H:%M:%SZ)] chaos.kind=api_restart docker compose restart api" >> "$CHAOS_LOG"
    # shellcheck disable=SC2086
    docker compose $DOCKER_COMPOSE_FILES restart api >> "$CHAOS_LOG" 2>&1 || true
}
chaos_action_pg_restart() {
    echo "[$(date -u +%H:%M:%SZ)] chaos.kind=pg_restart docker compose restart postgres" >> "$CHAOS_LOG"
    # shellcheck disable=SC2086
    docker compose $DOCKER_COMPOSE_FILES restart postgres >> "$CHAOS_LOG" 2>&1 || true
}

chaos_loop() {
    if [ "$CHAOS_INTERVAL" -le 0 ]; then
        echo "[$(date -u +%H:%M:%SZ)] chaos disabled" >> "$CHAOS_LOG"
        return
    fi
    if (( ${#CHAOS_ACTIONS[@]} == 0 )); then
        echo "[$(date -u +%H:%M:%SZ)] chaos.error empty_CHAOS_KINDS — nothing to dispatch" >> "$CHAOS_LOG"
        return
    fi
    echo "[$(date -u +%H:%M:%SZ)] chaos.kinds=${CHAOS_KINDS}" >> "$CHAOS_LOG"
    local i=0
    while true; do
        sleep "$CHAOS_INTERVAL"
        local action="${CHAOS_ACTIONS[$((i % ${#CHAOS_ACTIONS[@]}))]}"
        case "$action" in
            worker_term)            chaos_action_worker_term ;;
            worker_kill)            chaos_action_worker_kill ;;
            worker_fleet_collapse)  chaos_action_worker_fleet_collapse ;;
            api_restart)            chaos_action_api_restart ;;
            pg_restart)             chaos_action_pg_restart ;;
            *) echo "[$(date -u +%H:%M:%SZ)] chaos.unknown_kind=$action — skipping" >> "$CHAOS_LOG" ;;
        esac
        i=$((i + 1))
    done
}

# --- Snapshot loop -----------------------------------------------------------
snapshot_loop() {
    while true; do
        bash "$REPO_ROOT/scripts/soak/snapshot.sh" >> "$SNAPSHOT_LOG" 2>&1 || true
        sleep "$SNAPSHOT_INTERVAL"
    done
}

enqueue_loop &  PIDS+=($!)
chaos_loop &    PIDS+=($!)
snapshot_loop & PIDS+=($!)

echo "[$(date -u +%H:%M:%SZ)] soak: started loops; waiting ${SOAK_DURATION_SECONDS}s before exit"
sleep "$SOAK_DURATION_SECONDS"
