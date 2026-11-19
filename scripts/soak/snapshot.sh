#!/usr/bin/env bash
# One stack snapshot to stdout (ts-prefixed lines for grepping).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_FILE="$REPO_ROOT/scripts/soak/sql/snapshot.sql"
DOCKER_COMPOSE_FILES="${DOCKER_COMPOSE_FILES:--f $REPO_ROOT/deployments/compose/docker-compose.yml}"

TS=$(date +%s)
PREFIX="ts=$TS"

# --- Container resource snapshot --------------------------------------------- `docker stats --no-stream` returns one row per container with CPU%, mem%, mem usage.
emit_docker_stats() {
    # shellcheck disable=SC2086
    docker compose $DOCKER_COMPOSE_FILES ps -q 2>/dev/null \
        | xargs -r docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' \
        | awk -v p="$PREFIX" '{ print p, "container=" $0 }'
}

emit_worker_containers() {
    docker ps --filter "label=com.docker.compose.service=worker" \
              --format '{{.Names}} {{.ID}}' 2>/dev/null \
    | while read -r name id; do
        [[ -z "$id" ]] && continue
        local info
        info=$(docker inspect "$id" \
            --format 'started_at={{.State.StartedAt}} restart_count={{.RestartCount}} state={{.State.Status}}' 2>/dev/null) \
            || continue
        echo "$PREFIX worker_container:$name id=$id $info"
    done
}

# --- DB-side metrics ---------------------------------------------------------
emit_sql_snapshot() {
    docker compose $DOCKER_COMPOSE_FILES exec -T postgres \
        psql -q -U "${POSTGRES_USER:-veyra}" -d "${POSTGRES_DB:-veyra}" -f - < "$SQL_FILE" \
        | awk -v p="$PREFIX" 'NF { print p, $0 }'
}

# --- Recent log tally (cheap signal for "is anything throwing?") -------------
emit_recent_errors() {
    # shellcheck disable=SC2086
    local since
    since=$(date -u -d '1 minute ago' +'%Y-%m-%dT%H:%M:%S' 2>/dev/null \
            || date -u -v-1M +'%Y-%m-%dT%H:%M:%S')
    local errs warns
    errs=$(docker compose $DOCKER_COMPOSE_FILES logs --since "${since}" 2>/dev/null \
           | grep -c '"level":"ERROR"' || true)
    warns=$(docker compose $DOCKER_COMPOSE_FILES logs --since "${since}" 2>/dev/null \
            | grep -c '"level":"WARN"' || true)
    echo "$PREFIX log_errors_last_1m=$errs"
    echo "$PREFIX log_warns_last_1m=$warns"
}

# --- Header ------------------------------------------------------------------
echo "$PREFIX snapshot=begin date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit_docker_stats         || echo "$PREFIX snapshot_warn=docker_stats_failed"
emit_worker_containers    || echo "$PREFIX snapshot_warn=worker_containers_failed"
emit_sql_snapshot         || echo "$PREFIX snapshot_warn=sql_failed"
emit_recent_errors        || echo "$PREFIX snapshot_warn=log_grep_failed"
echo "$PREFIX snapshot=end"
