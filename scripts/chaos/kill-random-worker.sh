#!/usr/bin/env bash
# Kill the worker process in one random veyra worker container (chaos).
# Usage: scripts/chaos/kill-random-worker.sh [SIGTERM|SIGKILL]

set -euo pipefail

SIGNAL="${1:-SIGTERM}"
SIGNAL_NAME="${SIGNAL#SIG}"

TARGETS=$(docker ps --filter "label=com.docker.compose.service=worker" \
                    --format '{{.Names}}')
COUNT=$(echo "$TARGETS" | grep -c . || true)

if [[ "$COUNT" -eq 0 ]]; then
    echo "chaos.error=no_running_worker_containers" >&2
    exit 1
fi

TARGET=$(echo "$TARGETS" | shuf -n 1)

# Capture the baseline RestartCount BEFORE the kill.
BASELINE_RC=$(docker inspect "$TARGET" --format '{{.RestartCount}}' 2>/dev/null || echo "0")
KILLED_AT=$(date +%s)

# Kill the worker binary specifically.
if ! docker exec "$TARGET" pkill "-$SIGNAL_NAME" worker; then
    echo "chaos.error=pkill_no_match chaos.target=$TARGET chaos.signal=$SIGNAL" >&2
    exit 2
fi

echo "chaos.target=$TARGET chaos.signal=$SIGNAL chaos.killed_at=$KILLED_AT chaos.baseline_restart_count=$BASELINE_RC"
