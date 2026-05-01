#!/usr/bin/env bash
set -euo pipefail

# Verify required environment variables
if [[ -z "${DAYTONA_API_KEY:-}" ]]; then
    echo "Error: DAYTONA_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${DAYTONA_BASE_SNAPSHOT:-}" ]]; then
    echo "Error: DAYTONA_BASE_SNAPSHOT environment variable is not set"
    exit 1
fi

echo "Daytona snapshot ${DAYTONA_BASE_SNAPSHOT} — checking if it already exists..."

# If the snapshot was already built manually (e.g. via `python -m src.bootstrap`),
# skip the rebuild to avoid needing Python/pip in the Terraform environment.
# To force a rebuild, delete the snapshot in the Daytona dashboard and re-run.
echo "Snapshot ${DAYTONA_BASE_SNAPSHOT} assumed to exist (built manually). Skipping rebuild."
echo "To rebuild, run: cd packages/daytona-infra && uv run --with daytona python -m src.bootstrap --force"
