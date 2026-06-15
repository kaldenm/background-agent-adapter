#!/bin/bash
# Tail live Cloudflare Worker logs for the OpenInspect control plane.
#
# Usage:
#   ./scripts/tail-logs.sh              # all logs
#   ./scripts/tail-logs.sh | grep error # filter for errors
#   ./scripts/tail-logs.sh | grep -i "anthropic\|pi\|sandbox\|execution"
#
# Requires: wrangler login (already done if you can deploy)

cd "$(dirname "$0")/../packages/server"
exec npx wrangler tail open-inspect-control-plane-aldenmyers --format pretty
