#!/usr/bin/env bash
# Tail compose logs. Usage: scripts/dev/logs.sh [service]

set -euo pipefail

COMPOSE_FILE="deployments/compose/docker-compose.yml"
cd "$(git rev-parse --show-toplevel)"

if [[ $# -eq 0 ]]; then
    exec docker compose -f "$COMPOSE_FILE" logs -f --tail=100
fi

exec docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "$@"
