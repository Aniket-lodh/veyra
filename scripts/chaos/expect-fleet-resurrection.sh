#!/usr/bin/env bash
# Assert all workers restart after kill-all-workers.sh.

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
RECOVERED_COUNT=0
EXPECTED_COUNT=${#BASELINES[@]}

while (( RECOVERED_COUNT < EXPECTED_COUNT )); do
    NOW=$(date +%s)
    if (( NOW > DEADLINE )); then
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

max_elapsed=0
for v in "${ELAPSED[@]}"; do
    if (( v > max_elapsed )); then max_elapsed=$v; fi
done
echo "chaos.fleet.recovery.summary recovered=$RECOVERED_COUNT expected=$EXPECTED_COUNT outcome=success max_recovery_seconds=$max_elapsed"
