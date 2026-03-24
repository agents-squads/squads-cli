#!/usr/bin/env bash
#
# Test squads-cli as a brand new user in a clean Docker container.
# Runs the full first-run flow and reports pass/fail for each step.
#
# Usage:
#   ./test/docker/test-fresh-user.sh           # Interactive mode
#   ./test/docker/test-fresh-user.sh --auto    # Automated test suite
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Building fresh-user Docker image ==="
docker build -f "$SCRIPT_DIR/Dockerfile.fresh-user" -t squads-fresh-user "$CLI_DIR"

if [ "${1:-}" = "--auto" ]; then
  echo ""
  echo "=== Running automated first-run test suite ==="

  docker run --rm squads-fresh-user bash -c '
    PASS=0
    FAIL=0

    test_step() {
      local name="$1"
      shift
      if "$@" > /tmp/output.txt 2>&1; then
        echo "  PASS  $name"
        PASS=$((PASS + 1))
      else
        echo "  FAIL  $name"
        echo "        $(tail -3 /tmp/output.txt | head -3)"
        FAIL=$((FAIL + 1))
      fi
    }

    echo ""
    echo "--- Step 1: squads --version ---"
    test_step "version" squads --version

    echo "--- Step 2: squads --help ---"
    test_step "help" squads --help

    echo "--- Step 3: squads init ---"
    test_step "init" squads init

    echo "--- Step 4: .agents directory created ---"
    test_step "agents-dir" test -d .agents/squads

    echo "--- Step 5: squads status ---"
    test_step "status" squads status

    echo "--- Step 6: squads list ---"
    test_step "list" squads list

    echo "--- Step 7: squads catalog list ---"
    test_step "catalog-list" squads catalog list

    echo "--- Step 8: squads doctor ---"
    test_step "doctor" squads doctor

    echo "--- Step 9: unknown command shows help ---"
    test_step "unknown-cmd" bash -c "squads nonexistent 2>&1 | grep -qi help || squads nonexistent 2>&1 | grep -qi error"

    echo ""
    echo "=== Results: $PASS passed, $FAIL failed ==="

    if [ "$FAIL" -gt 0 ]; then
      exit 1
    fi
  '
else
  echo ""
  echo "=== Starting interactive fresh-user container ==="
  echo "You are a new user. Try:"
  echo "  squads --version"
  echo "  squads init"
  echo "  squads status"
  echo "  squads catalog list"
  echo ""
  docker run --rm -it squads-fresh-user
fi
