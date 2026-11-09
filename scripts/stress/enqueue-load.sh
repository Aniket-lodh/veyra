#!/usr/bin/env bash
# Flood the api with enqueue requests (multi-worker load).

set -euo pipefail

N="${1:-200}"
QUEUE="${2:-default}"
API="${VEYRA_API_URL:-http://localhost:8008}"

echo "enqueueing $N jobs to $API queue=$QUEUE" >&2

for i in $(seq 1 "$N"); do
    curl -fsS -X POST "$API/jobs" \
        -H "content-type: application/json" \
        -H "x-request-id: stress-${i}" \
        -d '{
            "handler": "noop",
            "queue":   "'"$QUEUE"'",
            "payload": {"i": '"$i"', "source": "stress"},
            "maxAttempts": 3,
            "priority": 5
        }' >/dev/null
done

echo "done. tail worker logs to watch dequeue/ack." >&2
