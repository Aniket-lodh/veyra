#!/usr/bin/env bash
# Assert a killed worker container restarts within a bound.
# Paired with kill-random-worker.sh.

set -euo pipefail

TARGET="${1:?missing container name}"
KILLED_AT="${2:?missing killed_at unix ts}"
BASELINE_RC="${3:?missing baseline restart count (from kill-random-worker.sh)}"
BOUND_SECONDS="${4:-30}"

DEADLINE=$((KILLED_AT + BOUND_SECONDS))

while true; do
    NOW=$(date +%s)
    if (( NOW > DEADLINE )); then
        state=$(docker inspect "$TARGET" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
        rc=$(docker inspect "$TARGET" --format '{{.RestartCount}}' 2>/dev/null || echo "?")
        echo "chaos.recovery.failed target=$TARGET reason=timeout state=$state restartCount=$rc baselineRestartCount=$BASELINE_RC elapsed=$((NOW - KILLED_AT))"
        exit 1
    fi
    state=$(docker inspect "$TARGET" --format '{{.State.Status}}' 2>/dev/null || echo "")
    rc=$(docker inspect "$TARGET" --format '{{.RestartCount}}' 2>/dev/null || echo "")
    if [[ "$state" == "running" && -n "$rc" && "$rc" -gt "$BASELINE_RC" ]]; then
        elapsed=$((NOW - KILLED_AT))
        echo "chaos.recovery.target=$TARGET worker_recovery_seconds=$elapsed"
        exit 0
    fi
    sleep 1
done
