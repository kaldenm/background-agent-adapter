#!/usr/bin/env bash
set -euo pipefail

# Upload secrets to a Cloudflare Worker via wrangler.
# Required environment variable:
#   WORKER_NAME              - target worker name
#
# Optional environment variables are uploaded when present:
#   DAYTONA_API_KEY
#   GITHUB_APP_ID
#   GITHUB_APP_INSTALLATION_ID
#   GITHUB_APP_PRIVATE_KEY
#   GITHUB_CLIENT_SECRET
#   INTERNAL_CALLBACK_SECRET
#   NEXTAUTH_SECRET
#   REPO_SECRETS_ENCRYPTION_KEY
#   TOKEN_ENCRYPTION_KEY

echo "Uploading secrets to worker: ${WORKER_NAME}"

SECRET_NAMES=(
  DAYTONA_API_KEY
  GITHUB_APP_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_APP_PRIVATE_KEY
  GITHUB_CLIENT_SECRET
  INTERNAL_CALLBACK_SECRET
  NEXTAUTH_SECRET
  REPO_SECRETS_ENCRYPTION_KEY
  TOKEN_ENCRYPTION_KEY
)

uploaded=0
for secret_name in "${SECRET_NAMES[@]}"; do
  secret_value="${!secret_name:-}"
  if [[ -z "${secret_value}" ]]; then
    echo "Skipping ${secret_name}: environment variable not set"
    continue
  fi

  echo "Uploading ${secret_name}"
  printf '%s' "${secret_value}" | npx wrangler secret put "${secret_name}" --name "${WORKER_NAME}"
  uploaded=$((uploaded + 1))
done

if [[ "${uploaded}" -eq 0 ]]; then
  echo "No known secret environment variables were set; nothing uploaded." >&2
  exit 1
fi

echo "Secrets uploaded successfully"
