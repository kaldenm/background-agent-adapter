#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DAYTONA_API_KEY:-}" ]]; then
    echo "Error: DAYTONA_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${DAYTONA_API_URL:-}" ]]; then
    echo "Error: DAYTONA_API_URL environment variable is not set"
    exit 1
fi

if [[ -z "${DAYTONA_BASE_SNAPSHOT:-}" ]]; then
    echo "Error: DAYTONA_BASE_SNAPSHOT environment variable is not set"
    exit 1
fi

DAYTONA_INFRA_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
REPO_ROOT="$(cd "$DAYTONA_INFRA_PATH/../.." && pwd)"
SNAPSHOT_COMMAND="$REPO_ROOT/scripts/daytona-snapshot.ts"

if [[ ! -f "$SNAPSHOT_COMMAND" ]]; then
    echo "Error: Daytona snapshot command not found at $SNAPSHOT_COMMAND"
    exit 1
fi

MODE="${DAYTONA_SNAPSHOT_MODE:-manual}"
DRY_RUN_ARGS=()
if [[ "${DAYTONA_SNAPSHOT_DRY_RUN:-}" == "1" ]]; then
    DRY_RUN_ARGS+=(--dry-run)
fi

case "$MODE" in
    manual)
        echo "Daytona snapshot mode: manual"
        echo "Using existing Daytona snapshot ${DAYTONA_BASE_SNAPSHOT}; no build or live verification attempted."
        ;;
    verify)
        node --experimental-strip-types "$SNAPSHOT_COMMAND" verify "${DRY_RUN_ARGS[@]}"
        ;;
    build)
        node --experimental-strip-types "$SNAPSHOT_COMMAND" build "${DRY_RUN_ARGS[@]}"
        ;;
    *)
        echo "Error: DAYTONA_SNAPSHOT_MODE must be manual, verify, or build"
        exit 1
        ;;
esac
