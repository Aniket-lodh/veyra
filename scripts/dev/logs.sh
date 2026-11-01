#!/usr/bin/env bash
# Tail the logs of one service, or all if no arg is given.
#
# Usage:
#   scripts/dev/logs.sh             # tail every service
#   scripts/dev/logs.sh worker      # tail every worker replica
#   scripts/dev/logs.sh api         # tail only the api
#
# In production, prefer `docker logs --follow` against a specific container
# id pulled from `docker compose ps` — this script is the developer shortcut.
set -euo pipefail

COMPOSE_FILE="deployments/compose/docker-compose.yml"
cd "$(git rev-parse --show-toplevel)"

if [[ $# -eq 0 ]]; then
    exec docker compose -f "$COMPOSE_FILE" logs -f --tail=100
fi

exec docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "$@"
