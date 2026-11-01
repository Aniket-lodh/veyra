#!/usr/bin/env bash
# Stop the dev stack. Preserves the postgres volume — for a destructive
# reset, pass --wipe.
#
# Usage:
#   scripts/dev/down.sh             # graceful stop, volume kept
#   scripts/dev/down.sh --wipe      # also drops the postgres volume
set -euo pipefail

COMPOSE_FILE="deployments/compose/docker-compose.yml"
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--wipe" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v
else
    docker compose -f "$COMPOSE_FILE" down
fi
