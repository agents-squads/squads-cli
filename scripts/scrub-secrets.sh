#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Git history secret scrub for squads-cli (PUBLIC REPO)
#
# Removes leaked secrets from git history using git-filter-repo.
# This rewrites history — all collaborators must re-clone after.
#
# Prerequisites:
#   brew install git-filter-repo   (or pip install git-filter-repo)
#
# What gets scrubbed:
#   1. Telemetry API key (base64-encoded)
#   2. Telemetry endpoint URL (base64-encoded)
#   3. Local DB credentials (two connection strings)
#
# Usage:
#   1. Review this script
#   2. Run: bash scripts/scrub-secrets.sh
#   3. Verify: git log -p --all -S '<pattern>' should return nothing
#   4. Force push: git push --force --all && git push --force --tags
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Preflight
if ! command -v git-filter-repo &>/dev/null; then
  echo "ERROR: git-filter-repo not found"
  echo "Install: brew install git-filter-repo"
  exit 1
fi

# Safety: must be on a clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree not clean. Commit or stash changes first."
  exit 1
fi

echo "=== Strings to scrub from git history ==="
echo ""
echo "1. Telemetry API key (base64):     c3FfdGVsX3YxXzdmOGE5YjJjM2Q0ZTVmNmE="
echo "2. Telemetry endpoint (base64):    aHR0cHM6Ly9zcXVhZHMtdGVsZW1ldHJ5LTk3ODg3MTgxNzYxMC51cy1jZW50cmFsMS5ydW4uYXBwL3Bpbmc="
echo "3. DB credential 1:               postgresql://user:password@localhost:5432/squads"
echo "4. DB credential 2:               postgresql://squads:squads_local_dev@localhost:5433/squads"
echo ""
echo "This will REWRITE git history. All collaborators must re-clone."
echo ""
read -p "Continue? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

# Create the replacements file
REPLACEMENTS=$(mktemp)
cat > "$REPLACEMENTS" <<'REPLACE'
c3FfdGVsX3YxXzdmOGE5YjJjM2Q0ZTVmNmE===>REDACTED_TELEMETRY_KEY
aHR0cHM6Ly9zcXVhZHMtdGVsZW1ldHJ5LTk3ODg3MTgxNzYxMC51cy1jZW50cmFsMS5ydW4uYXBwL3Bpbmc===>REDACTED_TELEMETRY_ENDPOINT
postgresql://user:password@localhost:5432/squads==>REDACTED_DB_URL
postgresql://squads:squads_local_dev@localhost:5433/squads==>REDACTED_DB_URL
REPLACE

echo "▶ Running git-filter-repo with blob replacements..."
git filter-repo --replace-text "$REPLACEMENTS" --force

rm -f "$REPLACEMENTS"

echo ""
echo "=== Verification ==="
echo ""

# Verify scrub worked
FOUND=0
for pattern in "c3FfdGVsX3YxXzdm" "aHR0cHM6Ly9zcXVhZHMtdGVsZW1ldHJ5" "user:password@localhost" "squads_local_dev"; do
  HITS=$(git log --all -p | grep -c "$pattern" 2>/dev/null || true)
  if [ "$HITS" -gt 0 ]; then
    echo "FAIL: '$pattern' still found $HITS time(s)"
    FOUND=1
  else
    echo "OK:   '$pattern' scrubbed"
  fi
done

echo ""
if [ "$FOUND" -eq 0 ]; then
  echo "All secrets scrubbed from git history."
  echo ""
  echo "Next steps:"
  echo "  1. git push --force --all"
  echo "  2. git push --force --tags"
  echo "  3. Tell collaborators to re-clone (git pull won't work after rewrite)"
  echo "  4. Rotate the telemetry API key server-side (if not already done)"
else
  echo "WARNING: Some secrets still found. Manual investigation needed."
fi
