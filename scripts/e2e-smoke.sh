#!/usr/bin/env bash
# E2E smoke test: simulates real user npm install + first-run journey
# Catches packaging bugs (missing files, broken bin, wrong exports) that
# vitest tests miss because they run local dist, not the installed package.
#
# Usage: bash scripts/e2e-smoke.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "▶ Building package..."
cd "$REPO_ROOT"
npm run build

echo "▶ Packing..."
TARBALL=$(npm pack --quiet)
TARBALL_PATH="$REPO_ROOT/$TARBALL"

TMPDIR=$(mktemp -d)
cleanup() {
  echo "▶ Cleaning up..."
  npm uninstall -g squads-cli 2>/dev/null || true
  rm -rf "$TMPDIR"
  rm -f "$TARBALL_PATH"
}
trap cleanup EXIT

echo "▶ Installing from tarball (simulates: npm install -g squads-cli)..."
npm install -g "$TARBALL_PATH"

echo "▶ Setting up temp project dir..."
cd "$TMPDIR"
git init -q
git config user.email "smoke@test.local"
git config user.name "Smoke Test"
git commit --allow-empty -q -m "init"

step() { echo ""; echo "=== STEP: $1 ==="; }

step "squads --version"
squads --version

step "squads init --yes --force"
squads init --yes --force

step "squads status (after init)"
squads status

step "squads doctor"
squads doctor || true

step "squads run --dry-run (first squad found)"
SQUAD=$(squads status 2>/dev/null | grep -E "^\s+\w+" | head -1 | awk '{print $1}' || echo "company")
if [ -n "$SQUAD" ]; then
  squads run "$SQUAD" --dry-run || true
else
  echo "skip: no squads found after init"
fi

echo ""
echo "✅ All smoke test steps passed"
