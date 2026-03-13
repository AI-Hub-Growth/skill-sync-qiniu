#!/usr/bin/env bash
# Usage:
#   ./sync.sh --root /path/to/skills --dry-run
#   ./sync.sh --root /path/to/skills --changelog "Initial release"
#   ./sync.sh --root /path/to/skills --bump minor --changelog "New features"
#   ./sync.sh --root ./skills --root /other/skills --output /tmp/manifest.ndjson
#   ./sync.sh --sources sources.json --dry-run
#   ./sync.sh --sources sources.json --bump patch
#
# Requires .env in the same directory (copy from .env.template and fill in values).
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
