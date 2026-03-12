#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node &>/dev/null; then
  node "$SCRIPT_DIR/sync.mjs" "$@"
elif command -v bun &>/dev/null; then
  bun run "$SCRIPT_DIR/sync.mjs" "$@"
else
  echo "Error: node or bun is required" >&2
  exit 1
fi
