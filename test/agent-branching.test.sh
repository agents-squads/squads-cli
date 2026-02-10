#!/usr/bin/env bash
# TDD: Agent branching behavior tests
# Tests that `squads run --background` enforces proper branch workflow
#
# Expected behavior:
# 1. Agent runs on a branch (agent/{squad}/{agent}-{timestamp}), NOT main
# 2. The shell script includes git checkout -b before exec claude
# 3. Memory commits go to main (OK)
# 4. Work product commits go to the agent branch
# 5. PID file is created with correct name
# 6. After completion, branch exists with agent's commits

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

assert_not_contains() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    fail "$desc" "should NOT contain '$needle'"
  else
    pass "$desc"
  fi
}

assert_file_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" path="$2"
  if [ -f "$path" ]; then
    pass "$desc"
  else
    fail "$desc" "file not found: $path"
  fi
}

assert_file_not_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local desc="$1" path="$2"
  if [ -f "$path" ]; then
    fail "$desc" "file should not exist: $path"
  else
    pass "$desc"
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

# ============================================================================
# SETUP: Create sandbox environment
# ============================================================================

SANDBOX=$(mktemp -d)
trap "rm -rf $SANDBOX" EXIT

echo -e "\n${YELLOW}Setting up sandbox at $SANDBOX${NC}\n"

# Create a fake 'claude' that simulates agent work
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/claude" << 'MOCK_CLAUDE'
#!/usr/bin/env bash
# Mock claude that simulates an agent making commits
# It reads the prompt and makes some commits

PROMPT="$*"
REPO_DIR=$(pwd)

# Simulate: agent creates a work product file
mkdir -p reports
echo "# Agent Report $(date)" > reports/test-report.md
echo "Analysis complete." >> reports/test-report.md

# Simulate: agent commits work product
git add reports/
git commit -m "feat(test-squad): agent work product

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
# TEST SUITE 1: Branch creation on agent spawn
# ============================================================================

echo -e "${YELLOW}TEST SUITE 1: Branch creation${NC}"

# Test: After squads run --background, a branch should exist
# For now, we test by examining what the CLI SHOULD do
# (Run with mock claude in PATH)

export PATH="$SANDBOX/bin:$PATH"

# Test: squads run --background creates agent branch
echo -e "\n${YELLOW}Running: squads run test-squad/test-agent --background --dry-run${NC}"
DRY_OUTPUT=$(cd "$PROJECT" && squads run test-squad/test-agent --dry-run 2>&1 || true)

assert_contains "dry-run shows agent name" "$DRY_OUTPUT" "test-agent"

# ============================================================================
# TEST SUITE 2: Actual background execution with branch enforcement
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 2: Background execution with branches${NC}"

# Run the agent in background (with mock claude)
cd "$PROJECT"
BG_OUTPUT=$(squads run test-squad/test-agent --background --model haiku 2>&1 || true)

# Wait for mock agent to complete
sleep 3

# Test: Agent branch was created
assert_branch_exists "agent branch created" "agent/test-squad/test-agent-*" "$PROJECT"

# Test: Main branch is unchanged (no new commits on main)
assert_main_clean "main branch untouched" "$PROJECT" "$INITIAL_COMMIT"

# Test: Current branch is back to main after agent completes
assert_on_branch "repo back on main after agent" "main" "$PROJECT"

# Test: Agent's work product commit is on the agent branch
AGENT_BRANCH=$(git -C "$PROJECT" branch --list "agent/test-squad/test-agent-*" | tr -d ' ' | head -1)
if [ -n "$AGENT_BRANCH" ]; then
  BRANCH_FILES=$(git -C "$PROJECT" diff --name-only main..."$AGENT_BRANCH" 2>/dev/null)
  assert_contains "work product on agent branch" "$BRANCH_FILES" "reports/test-report.md"
else
  fail "agent branch has commits" "no agent branch found"
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

# Test: After process dies, PID file should be cleaned up
# (This is the scheduler's job, but we test the file exists for now)

# ============================================================================
# TEST SUITE 4: Prompt includes branch instructions
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 4: Prompt content${NC}"

# Test: The prompt tells the agent about its branch
PROMPT_OUTPUT=$(cd "$PROJECT" && squads run test-squad/test-agent --dry-run --verbose 2>&1 || true)

# The prompt should mention branching or the branch name
# (This will fail until we add branch instructions to the prompt)
assert_contains "prompt mentions branch workflow" "$PROMPT_OUTPUT" "branch"

# ============================================================================
# TEST SUITE 5: Memory vs work product separation
# ============================================================================

echo -e "\n${YELLOW}TEST SUITE 5: Memory vs work product separation${NC}"

# Memory files (.agents/memory/) should be on main
# Work products (reports/) should be on agent branch only

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
