#!/usr/bin/env bash
# expect-worker-resurrection.sh — bounded recovery assertion paired
# with kill-random-worker.sh.
#
# Polls `docker inspect <target>` until the container is back to
# state=running with an incremented RestartCount, or until the bound
# elapses. Emits exactly one stdout line:
#
#   Success:  chaos.recovery.target=<name> worker_recovery_seconds=<n>
#   Failure:  chaos.recovery.failed target=<name> reason=<r> elapsed=<n> ...
#
# Why this script exists: "chaos must assert recovery". A chaos
# scenario that proves "we killed it" without proving "it came back"
# is a half-test, and the 2026-05-26 soak ran 4.5h after workers
# stopped existing because of exactly that gap. The bound is the
# contract — "eventually restarted" is not enough.
#
# See docs/SOAK_REPORT.md run 20260526T122313Z, finding A1, and
# the chaos-must-assert-recovery memory.
#
# Usage:
#   expect-worker-resurrection.sh <container-name> <killed-at-unix-ts> <baseline-restart-count> [bound-seconds]
#
# The baseline RestartCount MUST be captured by the kill script before
# the kill, not by this script: under `unless-stopped` the engine
# restarts the container within ~1s — typically before this script's
# first `docker inspect` lands — so a baseline captured here would
# already be the post-restart value and the assertion would wait
# forever for one more restart.
#
# Default bound: 30s. Under `unless-stopped` the restart fires within
# 1–2s in practice. We measure from the kill timestamp (not from
# this script's start) so the metric captures end-to-end recovery,
# not just our polling latency.
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
