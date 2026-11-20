#!/usr/bin/env bash
# Stop the dev stack (keeps postgres volume unless --wipe).

set -euo pipefail

COMPOSE_FILE="deployments/compose/docker-compose.yml"
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--wipe" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v
else
    docker compose -f "$COMPOSE_FILE" down
fi
