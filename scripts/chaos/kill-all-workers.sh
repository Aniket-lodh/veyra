#!/usr/bin/env bash
# Kill the worker process in every veyra worker container (fleet-collapse chaos).

set -euo pipefail

SIGNAL="${1:-SIGKILL}"
SIGNAL_NAME="${SIGNAL#SIG}"

TARGETS=$(docker ps --filter "label=com.docker.compose.service=worker" \
                    --format '{{.Names}}')
COUNT=$(echo "$TARGETS" | grep -c . || true)

if [[ "$COUNT" -eq 0 ]]; then
    echo "chaos.fleet.error=no_running_worker_containers" >&2
    exit 1
fi

for tgt in $TARGETS; do
    rc=$(docker inspect "$tgt" --format '{{.RestartCount}}' 2>/dev/null || echo 0)
    echo "chaos.fleet.worker target=$tgt baseline_restart_count=$rc"
done

KILLED_AT=$(date +%s)

for tgt in $TARGETS; do
    docker exec "$tgt" pkill "-$SIGNAL_NAME" worker &
done
wait

echo "chaos.fleet.summary signal=$SIGNAL killed_at=$KILLED_AT targets=$COUNT"
