#!/usr/bin/env bash
# Bring up the dev stack (postgres + api + worker) in the foreground.
#
# Usage:
#   scripts/dev/up.sh              # 1 worker
#   scripts/dev/up.sh 5            # 5 workers
#
# Logs stream to the terminal as multiplexed JSON/text per service. Ctrl-C
# triggers a graceful shutdown — see apps/{api,worker} main.go for the
# signal-handling story.
set -euo pipefail

WORKERS="${1:-1}"
COMPOSE_FILE="deployments/compose/docker-compose.yml"

cd "$(git rev-parse --show-toplevel)"

exec docker compose -f "$COMPOSE_FILE" up --build --scale "worker=$WORKERS"
