#!/usr/bin/env bash
# Bring up the dev stack (postgres + api + worker).
# Usage: scripts/dev/up.sh [worker_replicas]

set -euo pipefail

WORKERS="${1:-1}"
COMPOSE_FILE="deployments/compose/docker-compose.yml"

cd "$(git rev-parse --show-toplevel)"

exec docker compose -f "$COMPOSE_FILE" up --build --scale "worker=$WORKERS"
