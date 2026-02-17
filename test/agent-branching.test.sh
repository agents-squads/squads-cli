#!/usr/bin/env bash
# TDD: Agent branching behavior tests
# Tests that agents follow proper branch workflow conventions
#
# Expected behavior:
# 1. Agent creates its own descriptive branch (feat/, fix/, docs/, solve/)
# 2. Agent commits work products to its branch, NOT main
# 3. Branch name describes the WORK, not the agent
# 4. Conventional Commits format used
# 5. PID file is created with correct name
# 6. Main stays clean — no agent commits on main

set -euo pipefail

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
FAILURES=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo -e "  ${GREEN}PASS${NC} $1"
}

fail() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILURES="${FAILURES}\n  ${RED}FAIL${NC} $1: $2"
  echo -e "  ${RED}FAIL${NC} $1: $2"
}

assert_eq() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc"
  else
    fail "$desc" "expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc" "expected to contain '$needle'"
  fi
}

assert_branch_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" branch_pattern="$2" repo_dir="$3"
  local branches
  branches=$(git -C "$repo_dir" branch --list "$branch_pattern" 2>/dev/null)
  if [ -n "$branches" ]; then
    pass "$desc"
  else
    fail "$desc" "no branch matching '$branch_pattern' in $repo_dir"
  fi
}

assert_on_branch() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" expected_branch="$2" repo_dir="$3"
  local current
  current=$(git -C "$repo_dir" branch --show-current 2>/dev/null)
  if [ "$current" = "$expected_branch" ]; then
    pass "$desc"
  else
    fail "$desc" "expected branch '$expected_branch', on '$current'"
  fi
}

assert_main_clean() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" repo_dir="$2" initial_commit="$3"
  local current_main
  current_main=$(git -C "$repo_dir" rev-parse main 2>/dev/null)
  if [ "$current_main" = "$initial_commit" ]; then
    pass "$desc"
  else
    fail "$desc" "main has new commits (was $initial_commit, now $current_main)"
  fi
}

assert_branch_name_convention() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" repo_dir="$2"
  local branches
  # Get non-main branches
  branches=$(git -C "$repo_dir" branch --list | grep -v '^\*\? *main$' | tr -d ' *')
  local valid=true
  for branch in $branches; do
    # Must start with feat/, fix/, docs/, solve/, chore/, refactor/, test/
    if ! echo "$branch" | grep -qE '^(feat|fix|docs|solve|chore|refactor|test)/'; then
      fail "$desc" "branch '$branch' does not follow conventions (feat/, fix/, docs/, solve/...)"
      return
    fi
  done
  pass "$desc"
}

# ============================================================================
# SETUP: Create sandbox environment
# ============================================================================

SANDBOX=$(mktemp -d)
trap "rm -rf $SANDBOX" EXIT

echo -e "\n${YELLOW}Setting up sandbox at $SANDBOX${NC}\n"

# Create a fake 'claude' that simulates a well-behaved agent
# The agent creates its own branch following conventions
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/claude" << 'MOCK_CLAUDE'
#!/usr/bin/env bash
# Mock claude that simulates a well-behaved agent:
# 1. Creates a descriptive branch (not squad/agent plumbing)
# 2. Commits with Conventional Commits format
# 3. Stays on its branch (never touches main)

PROMPT="$*"
REPO_DIR=$(pwd)

# Agent reads prompt, decides what it's doing, creates descriptive branch
git checkout -b feat/test-squad-report 2>/dev/null

# Simulate: agent creates a work product file
mkdir -p reports
echo "# Agent Report $(date)" > reports/test-report.md
echo "Analysis complete." >> reports/test-report.md

# Simulate: agent commits work product with conventional format
git add reports/
git commit -m "feat(test-squad): initial analysis report

Co-Authored-By: Claude <noreply@anthropic.com>" 2>/dev/null || true

# Simulate: agent updates memory
mkdir -p .agents/memory/test-squad/test-agent
echo "last_run: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > .agents/memory/test-squad/test-agent/state.md
git add .agents/memory/
git commit -m "memory(test-squad): test-agent state update

Co-Authored-By: Claude <noreply@anthropic.com>" 2>/dev/null || true

echo "Agent execution complete."
MOCK_CLAUDE
chmod +x "$SANDBOX/bin/claude"

# Create project repo (simulates a client's repo)
PROJECT="$SANDBOX/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init
git -C "$PROJECT" config user.email "test@test.com"
git -C "$PROJECT" config user.name "Test"

# Create initial structure
mkdir -p "$PROJECT/.agents/squads/test-squad"
mkdir -p "$PROJECT/.agents/memory/test-squad/test-agent"
mkdir -p "$PROJECT/.agents/logs/test-squad"

# Create SQUAD.md
cat > "$PROJECT/.agents/squads/test-squad/SQUAD.md" << 'SQUAD'
---
name: Test Squad
description: Test squad for branching behavior
---

## Mission
Test the branching enforcement.
SQUAD

# Create agent definition
cat > "$PROJECT/.agents/squads/test-squad/test-agent.md" << 'AGENT'
---
name: test-agent
squad: test-squad
role: Test agent for branch enforcement
model: claude-haiku-4-5
domain_repo: test-repo
timeout: 60
---

## Purpose
Test agent that creates a report.

## Instructions
1. Create a report in reports/
2. Update memory
AGENT

# Initial commit
git -C "$PROJECT" add -A
git -C "$PROJECT" commit -m "initial: project setup"
INITIAL_COMMIT=$(git -C "$PROJECT" rev-parse HEAD)

echo -e "${YELLOW}Initial commit: $INITIAL_COMMIT${NC}\n"

# ============================================================================
# TEST SUITE 1: Dry run shows agent info
# ============================================================================

echo -e "${YELLOW}TEST SUITE 1: Dry run${NC}"

export PATH="$SANDBOX/bin:$PATH"

echo -e "\n${YELLOW}Running: squads run test-squad/test-agent --dry-run${NC}"
DRY_OUTPUT=$(cd "$PROJECT" && squads run test-squad/test-agent --dry-run 2>&1 || true)

assert_contains "dry-run shows agent name" "$DRY_OUTPUT" "test-agent"

# ============================================================================
# TEST SUITE 2: Agent creates its own branch with proper conventions
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 2: Agent-created branch with conventions${NC}"

# Run the agent in background (with mock claude)
cd "$PROJECT"
BG_OUTPUT=$(squads run test-squad/test-agent --background --model haiku 2>&1 || true)

# Wait for mock agent to complete
sleep 3

# Test: Agent created a branch following conventions (feat/, fix/, etc.)
assert_branch_exists "agent created feat/ branch" "feat/*" "$PROJECT"

# Test: Branch name follows conventions
assert_branch_name_convention "branch follows naming conventions" "$PROJECT"

# Test: Main branch is unchanged (no new commits on main)
assert_main_clean "main branch untouched" "$PROJECT" "$INITIAL_COMMIT"

# Test: Agent's work product commit is on its branch
AGENT_BRANCH=$(git -C "$PROJECT" branch --list "feat/*" | tr -d ' *' | head -1)
if [ -n "$AGENT_BRANCH" ]; then
  BRANCH_FILES=$(git -C "$PROJECT" diff --name-only main..."$AGENT_BRANCH" 2>/dev/null)
  assert_contains "work product on agent branch" "$BRANCH_FILES" "reports/test-report.md"
else
  fail "agent branch has commits" "no feat/ branch found"
  TESTS_RUN=$((TESTS_RUN + 1))
fi

# ============================================================================
# TEST SUITE 3: PID file lifecycle
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 3: PID file lifecycle${NC}"

# Test: PID file was created
PID_FILES=$(ls "$PROJECT/.agents/logs/test-squad/"*.pid 2>/dev/null | wc -l | tr -d ' ')
assert_eq "PID file created" "1" "$PID_FILES"

# Test: PID file contains a number
if [ "$PID_FILES" -ge 1 ]; then
  PID_CONTENT=$(cat "$PROJECT/.agents/logs/test-squad/"*.pid 2>/dev/null | head -1)
  if [[ "$PID_CONTENT" =~ ^[0-9]+$ ]]; then
    pass "PID file contains valid PID"
    TESTS_RUN=$((TESTS_RUN + 1))
  else
    fail "PID file contains valid PID" "got: $PID_CONTENT"
    TESTS_RUN=$((TESTS_RUN + 1))
  fi
fi

# ============================================================================
# TEST SUITE 4: Prompt includes branch instructions
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 4: Commit conventions${NC}"

# Verify the agent's commits follow conventional format
if [ -n "$AGENT_BRANCH" ]; then
  COMMIT_MSG=$(git -C "$PROJECT" log --format=%s "$AGENT_BRANCH" --not main | head -1)
  # Should match type(scope): description
  if echo "$COMMIT_MSG" | grep -qE '^(feat|fix|docs|chore|memory|refactor|test)\('; then
    pass "commits follow conventional format"
    TESTS_RUN=$((TESTS_RUN + 1))
  else
    fail "commits follow conventional format" "got: $COMMIT_MSG"
    TESTS_RUN=$((TESTS_RUN + 1))
  fi
fi

# ============================================================================
# TEST SUITE 5: Work products NOT on main
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 5: Work product isolation${NC}"

MAIN_HAS_REPORT=$(git -C "$PROJECT" show main:reports/test-report.md >/dev/null 2>&1 && echo "yes" || echo "no")
assert_eq "work product NOT on main" "no" "$MAIN_HAS_REPORT"

if [ -n "$AGENT_BRANCH" ]; then
  BRANCH_HAS_REPORT=$(git -C "$PROJECT" show "${AGENT_BRANCH}:reports/test-report.md" >/dev/null 2>&1 && echo "yes" || echo "no")
  assert_eq "work product on agent branch" "yes" "$BRANCH_HAS_REPORT"
fi

# ============================================================================
# RESULTS
# ============================================================================

echo -e "\n${YELLOW}════════════════════════════════════════${NC}"
echo -e "${YELLOW}Results: $TESTS_PASSED/$TESTS_RUN passed, $TESTS_FAILED failed${NC}"

if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "\n${RED}Failures:${NC}${FAILURES}"
  echo -e "\n${YELLOW}════════════════════════════════════════${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  echo -e "${YELLOW}════════════════════════════════════════${NC}"
  exit 0
fi
