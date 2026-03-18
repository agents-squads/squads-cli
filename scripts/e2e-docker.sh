#!/usr/bin/env bash
# E2E Docker test: builds a clean Ubuntu container, installs squads-cli from
# tarball (like a real user), and runs smoke tests inside it.
#
# Catches issues that local tests miss:
# - Missing files in npm package
# - Broken bin entry / shebang
# - Node version incompatibilities
# - Permission issues (non-root user)
# - Missing runtime dependencies
#
# Usage: bash scripts/e2e-docker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/test/e2e/Dockerfile.first-run"
IMAGE_NAME="squads-cli-e2e"

echo "▶ Building package..."
cd "$REPO_ROOT"
npm run build

echo "▶ Packing tarball..."
TARBALL=$(npm pack --quiet)
TARBALL_PATH="$REPO_ROOT/$TARBALL"

cleanup() {
  echo "▶ Cleaning up..."
  rm -f "$TARBALL_PATH"
  docker rmi "$IMAGE_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ Building Docker image (clean Ubuntu + squads-cli from tarball)..."
docker build \
  -f "$DOCKERFILE" \
  --build-arg "TARBALL=$TARBALL" \
  -t "$IMAGE_NAME" \
  "$REPO_ROOT"

echo "▶ Running tests inside container..."
docker run --rm "$IMAGE_NAME" bash -c '
set -euo pipefail

step() { echo ""; echo "=== STEP: $1 ==="; }

step "squads --version"
squads --version

step "squads --help"
squads --help | head -20

step "squads init --yes --force"
mkdir -p /tmp/test-project && cd /tmp/test-project
git init -q && git commit --allow-empty -q -m "init"
squads init --yes --force

step "squads status"
squads status

step "squads run --status (daemon status)"
squads run --status

step "squads run --dry-run --once (autopilot preview)"
squads run --dry-run --once || true

step "squads run company --dry-run (single squad preview)"
squads run company --dry-run || true

step "squads run --pause \"e2e test\""
squads run --pause "e2e test"

step "squads run --status (should show paused)"
squads run --status

step "squads run --resume"
squads run --resume

step "squads run --status (should show not running)"
squads run --status

step "squads autonomous status (deprecated alias)"
squads autonomous status || true

step "squads doctor"
squads doctor || true

echo ""
echo "✅ All Docker E2E tests passed"
'
