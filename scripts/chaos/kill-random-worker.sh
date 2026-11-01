#!/usr/bin/env bash
# Kill the worker PROCESS inside one random veyra worker container.
# The engine sees this as a natural container exit (not a docker-
# mediated stop), so `restart: unless-stopped` triggers a restart.
# The reclaim path (queue-core §1.5) picks up its in-flight jobs once
# the lease expires.
#
# Why pkill from inside, not `docker kill`:
#
#   `docker kill` sets the daemon's HasBeenManuallyStopped flag, which
#   suppresses ALL restart policies (`unless-stopped`, `always`, and
#   `on-failure`). Killing the worker process from inside the
#   container via `docker exec ... pkill` leaves that flag clear, so
#   the container restarts naturally — matching what happens in
#   production when a worker panics or gets OOM-killed.
#
#   Killing PID 1 (tini) from inside doesn't work either: Linux PID-
#   namespace semantics make PID 1 immune to SIGKILL from within its
#   own namespace. We must signal the worker binary specifically.
#
#   See docs/SOAK_REPORT.md run 20260526T122313Z, finding A1, for the
#   full investigation.
#
# Usage:
#   scripts/chaos/kill-random-worker.sh           # default SIGTERM
#   scripts/chaos/kill-random-worker.sh SIGKILL   # hard crash
#
# Output (on success, single line to stdout):
#
#   chaos.target=<container-name> chaos.signal=<sig> chaos.killed_at=<unix-ts> chaos.baseline_restart_count=<n>
#
# scripts/chaos/expect-worker-resurrection.sh consumes this output to
# verify that the container restarts within a bound and to emit
# `worker_recovery_seconds`. The baseline RestartCount is captured
# BEFORE the kill (not by the assertion script) because the daemon
# can restart `unless-stopped` containers within ~1s — faster than
# the assertion's first inspect call, which would otherwise race and
# capture the post-restart count as its baseline.
set -euo pipefail

SIGNAL="${1:-SIGTERM}"
# busybox/coreutils pkill both accept "SIGKILL" and "KILL"; strip the
# SIG prefix to keep behavior identical across base images.
SIGNAL_NAME="${SIGNAL#SIG}"

# Pick the target by NAME (not container ID). Names are stable across
# restarts (e.g. `veyra-worker-2` stays `veyra-worker-2` after a
# restart-policy bounce); IDs are not. The resurrection assertion
# needs to look up the same container after restart.
TARGETS=$(docker ps --filter "label=com.docker.compose.service=worker" \
                    --format '{{.Names}}')
COUNT=$(echo "$TARGETS" | grep -c . || true)

if [[ "$COUNT" -eq 0 ]]; then
    echo "chaos.error=no_running_worker_containers" >&2
    exit 1
fi

TARGET=$(echo "$TARGETS" | shuf -n 1)

# Capture the baseline RestartCount BEFORE the kill. The assertion
# script uses this to detect a fresh restart (rc > baseline). Doing it
# in the assertion script is racy: `unless-stopped` restarts the
# container before the assertion's first inspect call lands.
BASELINE_RC=$(docker inspect "$TARGET" --format '{{.RestartCount}}' 2>/dev/null || echo "0")
KILLED_AT=$(date +%s)

# Kill the worker binary specifically. The binary name is `worker`
# (built by deployments/docker/worker.Dockerfile). pkill returns 0 if
# at least one process matched, 1 if none matched. "No worker process
# running but the container is up" is itself a chaos failure — surface
# it to the chaos log rather than silently no-op'ing.
if ! docker exec "$TARGET" pkill "-$SIGNAL_NAME" worker; then
    echo "chaos.error=pkill_no_match chaos.target=$TARGET chaos.signal=$SIGNAL" >&2
    exit 2
fi

echo "chaos.target=$TARGET chaos.signal=$SIGNAL chaos.killed_at=$KILLED_AT chaos.baseline_restart_count=$BASELINE_RC"
