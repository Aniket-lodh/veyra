#!/usr/bin/env bash
# Flood the api with enqueue requests. Useful for watching multi-worker
# dequeue concurrency, lease renewal under load, and reclaim-after-crash
# behaviour (combine with scripts/chaos/kill-random-worker.sh).
#
# Usage:
#   scripts/stress/enqueue-load.sh                    # 200 jobs, queue=default
#   scripts/stress/enqueue-load.sh 1000               # 1000 jobs
#   scripts/stress/enqueue-load.sh 1000 highprio      # to a non-default queue
#
# Reads VEYRA_API_URL from the env (defaults to http://localhost:8008).
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
