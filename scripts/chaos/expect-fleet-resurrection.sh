#!/usr/bin/env bash
# expect-fleet-resurrection.sh — bounded recovery assertion paired
# with kill-all-workers.sh.
#
# Reads the kill script's structured output from stdin (one
# `chaos.fleet.worker target=… baseline_restart_count=…` line per
# worker, plus the `chaos.fleet.summary killed_at=…` line) and polls
# every named worker until either:
#   - all RestartCounts exceed their pre-kill baselines AND the
#     containers are state=running   →  success, exit 0
#   - the bound elapses               →  failure, exit 1
#
# Emits per-worker success/failure lines and a final summary line.
# Failure lines are greppable: `chaos.fleet.recovery.failed` is the
# canonical "the fleet did not come back in time" signal that the
# soak summary counts.
#
# Usage:
#   kill-all-workers.sh | expect-fleet-resurrection.sh [BOUND_SECONDS]
#
# Default bound: 60s. The fleet-collapse scenario is more generous
# than the single-worker bound (30s) because we are also asserting
# that the restart policy spins up multiple replicas serially on the
# Docker daemon; 60s is comfortable while still small enough that a
# real regression surfaces.

set -euo pipefail

BOUND_SECONDS="${1:-60}"

declare -A BASELINES
KILLED_AT=""
while IFS= read -r line; do
    if [[ "$line" =~ ^chaos\.fleet\.worker[[:space:]]+target=([^[:space:]]+)[[:space:]]+baseline_restart_count=([0-9]+) ]]; then
        BASELINES[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
    elif [[ "$line" =~ ^chaos\.fleet\.summary[[:space:]]+.*killed_at=([0-9]+) ]]; then
        KILLED_AT=${BASH_REMATCH[1]}
    fi
done

if [[ -z "$KILLED_AT" || ${#BASELINES[@]} -eq 0 ]]; then
    echo "chaos.fleet.recovery.failed reason=missing_input bound_seconds=$BOUND_SECONDS"
    exit 1
fi

DEADLINE=$((KILLED_AT + BOUND_SECONDS))
declare -A RECOVERED
declare -A ELAPSED
# Track recovered count in a plain integer, NOT via ${#RECOVERED[@]}.
# bash (through 5.2) errors with "unbound variable" when ${#assoc[@]}
# is read on an empty associative array under `set -u` — which is the
# loop's initial state. That bug silently no-op'd this whole assertion
# in soak run 20260528T135813Z (every collapse logged
# "RECOVERED: unbound variable" and recorded zero recoveries).
RECOVERED_COUNT=0
EXPECTED_COUNT=${#BASELINES[@]}

while (( RECOVERED_COUNT < EXPECTED_COUNT )); do
    NOW=$(date +%s)
    if (( NOW > DEADLINE )); then
        # Emit one failed line per worker that did not recover, plus a
        # summary line so the soak summary's counter has a single
        # canonical anchor to grep against.
        for tgt in "${!BASELINES[@]}"; do
            if [[ -z "${RECOVERED[$tgt]:-}" ]]; then
                rc=$(docker inspect "$tgt" --format '{{.RestartCount}}' 2>/dev/null || echo "?")
                state=$(docker inspect "$tgt" --format '{{.State.Status}}' 2>/dev/null || echo unknown)
                echo "chaos.fleet.recovery.failed target=$tgt reason=timeout state=$state restartCount=$rc baselineRestartCount=${BASELINES[$tgt]} elapsed=$((NOW - KILLED_AT))"
            fi
        done
        echo "chaos.fleet.recovery.summary recovered=$RECOVERED_COUNT expected=$EXPECTED_COUNT outcome=failed elapsed=$((NOW - KILLED_AT))"
        exit 1
    fi
    for tgt in "${!BASELINES[@]}"; do
        if [[ -n "${RECOVERED[$tgt]:-}" ]]; then continue; fi
        state=$(docker inspect "$tgt" --format '{{.State.Status}}' 2>/dev/null || echo "")
        rc=$(docker inspect "$tgt" --format '{{.RestartCount}}' 2>/dev/null || echo "")
        if [[ "$state" == "running" && -n "$rc" && "$rc" -gt "${BASELINES[$tgt]}" ]]; then
            RECOVERED[$tgt]=1
            RECOVERED_COUNT=$((RECOVERED_COUNT + 1))
            elapsed=$((NOW - KILLED_AT))
            ELAPSED[$tgt]=$elapsed
            echo "chaos.fleet.recovery.target=$tgt worker_recovery_seconds=$elapsed"
        fi
    done
    sleep 1
done

# Compute max recovery time across the fleet. The fleet-collapse
# bound is the slowest container, not the fastest.
max_elapsed=0
for v in "${ELAPSED[@]}"; do
    if (( v > max_elapsed )); then max_elapsed=$v; fi
done
echo "chaos.fleet.recovery.summary recovered=$RECOVERED_COUNT expected=$EXPECTED_COUNT outcome=success max_recovery_seconds=$max_elapsed"
