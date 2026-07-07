#!/bin/bash
# Persona battery runner — the user-testing validator pointed at ourselves.
# Usage: test/e2e/personas/run-battery.sh [persona-name ...]  (default: all)
# Each persona = fresh Docker container + packed dev tarball + shimmed providers
# where needed. Zero API cost. Exit nonzero if ANY persona fails.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
TMP=$(mktemp -d)
cleanup() { rm -f "$TMP/squads-cli-dev.tgz"; rmdir "$TMP" 2>/dev/null; }
trap cleanup EXIT

echo "packing dev tarball..."
(cd "$ROOT" && npm pack --quiet >/dev/null 2>&1 && mv squads-cli-*.tgz "$TMP/squads-cli-dev.tgz") || { echo "pack failed"; exit 1; }

PERSONAS=${@:-$(ls "$DIR" | grep -E '^p[0-9]+-' | sed 's/\.sh$//')}
TOTAL_FAIL=0
for p in $PERSONAS; do
  echo "════ persona: $p"
  docker run --rm -e HOME=/root \
    -v "$DIR":/personas:ro \
    -v "$TMP/squads-cli-dev.tgz":/pkg/squads-cli-dev.tgz:ro \
    node:22-slim bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1 && bash /personas/$p.sh" \
    || TOTAL_FAIL=$((TOTAL_FAIL+1))
done
echo
[ "$TOTAL_FAIL" -eq 0 ] && echo "BATTERY PASS — all personas green" || { echo "BATTERY FAIL — $TOTAL_FAIL persona(s) failed"; exit 1; }
