#!/usr/bin/env bash
# kill-all-workers.sh — fleet-collapse chaos action.
#
# Kills the worker PROCESS in EVERY veyra worker container in
# parallel, simulating the production case where the host loses every
# replica at once (mass deploy gone wrong, hypervisor pause, node
# failure). Pairs with expect-fleet-resurrection.sh for the bounded
# recovery assertion. Per the post-A2 SOAK plan:
#
#   "repeated fleet collapse → reclaim tick must requeue in-flight
#    rows while no workers exist → workers come back via the
#    restart policy → jobs resume processing."
#
# This is the validation scenario for the reclaim tick — kill-random
# never produces "zero workers" because the survivors keep dequeuing.
# Only a simultaneous fleet kill creates the fleet-collapse condition.
#
# Why pkill (not docker kill): docker kill sets the daemon's
# HasBeenManuallyStopped flag and the restart policy never fires.
# See feedback-docker-kill-vs-inside-kill memory + SOAK_REPORT.md A1.
#
# Usage:
#   scripts/chaos/kill-all-workers.sh [SIGNAL]    # default SIGKILL
#
# Output (multi-line, structured): one line per worker with the
# pre-kill RestartCount baseline, then a summary line. The structure
# is consumed by expect-fleet-resurrection.sh via stdin.
#
#   chaos.fleet.worker target=<name> baseline_restart_count=<n>
#   chaos.fleet.worker target=<name> baseline_restart_count=<n>
#   chaos.fleet.worker target=<name> baseline_restart_count=<n>
#   chaos.fleet.summary signal=<sig> killed_at=<unix> targets=<count>

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

# Capture all baselines BEFORE killing anything (avoids the post-kill
# race detailed in feedback-docker-kill-vs-inside-kill).
for tgt in $TARGETS; do
    rc=$(docker inspect "$tgt" --format '{{.RestartCount}}' 2>/dev/null || echo 0)
    echo "chaos.fleet.worker target=$tgt baseline_restart_count=$rc"
done

KILLED_AT=$(date +%s)

# Fire kills in parallel — serial kills would let the first target
# restart before the last one dies, which would NOT be a fleet
# collapse.
for tgt in $TARGETS; do
    docker exec "$tgt" pkill "-$SIGNAL_NAME" worker &
done
wait

echo "chaos.fleet.summary signal=$SIGNAL killed_at=$KILLED_AT targets=$COUNT"
