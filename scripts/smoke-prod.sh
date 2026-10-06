#!/usr/bin/env bash
# Run the smoke suite against the deployed hosted endpoint using the local .env key.
set -euo pipefail
ROO_API_KEY=$(grep '^ROO_API_KEY=' .env | cut -d= -f2-)
export ROO_API_KEY
exec bash scripts/smoke-http.sh https://mcp.roo.bz
