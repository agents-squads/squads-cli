---
name: squads-cli
description: Squads CLI reference for autonomous agents — run squads, manage memory, check status, set goals, and operate the AI workforce. TRIGGER when using squads commands, dispatching agents, reading/writing memory, checking squad status, or operating the autonomous loop.
context: fork
---

# Squads CLI

The `squads` CLI is the operating system for your AI workforce. Agents are the primary users — they call these commands during execution to understand context, persist learnings, and coordinate with other squads.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Squad** | A team of agents in `.agents/squads/{name}/` — defined by `SQUAD.md` |
| **Agent** | A markdown file (`{agent}.md`) inside a squad directory |
| **Memory** | Persistent state in `.agents/memory/{squad}/{agent}/` — survives across runs |
| **Target** | `squad/agent` notation (e.g., `engineering/issue-solver`) |
| **Context cascade** | Layered context injection: SYSTEM → SQUAD → priorities → directives → state |

## File Structure

```
.agents/
├── config/SYSTEM.md              # Immutable rules (all agents)
├── squads/{squad}/
│   ├── SQUAD.md                  # Squad identity, goals, KPIs
│   └── {agent}.md                # Agent definition
└── memory/
    ├── {squad}/
    │   ├── priorities.md          # Current operational focus
    │   ├── feedback.md            # Last cycle evaluation
    │   ├── active-work.md         # Open PRs/issues
    │   └── {agent}/
    │       ├── state.md           # Agent's persistent state
    │       └── learnings.md       # Accumulated insights
    ├── company/directives.md      # Strategic overlay
    └── daily-briefing.md          # Cross-squad context
```

---

## Running Agents

### Single Agent

```bash
# Run specific agent (two equivalent notations)
squads run engineering/issue-solver
squads run engineering -a issue-solver

# With founder directive (replaces lead briefing)
squads run engineering/issue-solver --task "Fix CI pipeline for PR #593"

# Dry run — preview without executing
squads run engineering --dry-run

# Background execution
squads run engineering/scanner -b          # Detached
squads run engineering/scanner -w          # Detached but tail logs

# Use different LLM provider
squads run research/analyst --provider=google
squads run research/analyst --provider=google --model=gemini-2.5-flash
```

### Squad Conversation

Run an entire squad as a coordinated team. Lead briefs → workers execute → lead reviews → iterate until convergence.

```bash
squads run research                        # Sequential conversation
squads run research --parallel             # All agents in parallel (tmux)
squads run research --lead                 # Single orchestrator with Task tool
squads run research --max-turns 10         # Limit conversation turns
squads run research --cost-ceiling 15      # Budget cap in USD
```

### Autopilot (Autonomous Dispatch)

No target = autopilot mode. CLI scores squads by priority, dispatches automatically.

```bash
squads run                                 # Start autopilot
squads run --once                          # Single cycle then exit
squads run --once --dry-run                # Preview what would dispatch
squads run -i 15 --budget 50              # 15-min cycles, $50/day cap
squads run --phased                        # Respect depends_on ordering
squads run --max-parallel 3               # Up to 3 squads simultaneously
```

### Execution Options

| Flag | Purpose |
|------|---------|
| `--verbose` | Detailed output with context sections logged |
| `--timeout <min>` | Execution timeout (default: 30 min) |
| `--effort <level>` | `high`, `medium`, `low` (default: from SQUAD.md or high) |
| `--skills <ids>` | Load additional skills |
| `--cloud` | Dispatch to cloud worker (requires `squads login`) |
| `--no-verify` | Skip post-execution verification |
| `--no-eval` | Skip post-run COO evaluation |
| `--json` | Machine-readable output |

---

## Memory Operations

Memory is how agents persist knowledge across runs. Files-first — everything is markdown on disk.

### Read Memory

```bash
# View all memory for a squad
squads memory read engineering

# Search across ALL squad memory
squads memory query "CI pipeline failures"
squads memory query "agent performance"
```

### Write Memory

```bash
# Write insight to squad memory
squads memory write research "MCP adoption rate at 15% — up from 8% last month"

# Write to specific agent
squads memory write engineering --agent issue-solver "PR #593 blocked by flaky test"
```

### Capture Learnings

```bash
# Quick learning capture
squads learn "Google blocks headless Chrome OAuth — use cookie injection" \
  --squad engineering --category pattern --tags "auth,chrome,e2e"

# View learnings
squads learnings
squads learnings --squad engineering
```

### Sync Memory

```bash
squads sync                    # Pull remote changes
squads sync --push             # Pull + push local changes
squads sync --postgres         # Also sync to Postgres
```

---

## Status & Monitoring

### Squad Status

```bash
squads status                  # All squads overview
squads status engineering      # Specific squad details
squads status -v               # Verbose with agent details
squads status --json           # Machine-readable
```

### Dashboards

```bash
squads dash                    # Overview dashboard
squads dash engineering        # Squad-specific dashboard
squads dash --ceo              # Executive summary
squads dash --full             # Include GitHub PR/issue stats (~30s)
squads dash --list             # List available dashboards
```

### Execution History

```bash
squads exec list               # Recent executions
squads exec list --squad eng   # Filter by squad
squads exec show <id>          # Execution details
squads exec stats              # Aggregate statistics
```

### Cost Tracking

```bash
squads cost                    # Today + this week
squads cost --squad research   # Squad-specific costs
squads cost --json             # Machine-readable
```

### Health & Readiness

```bash
squads doctor                  # Check tools, auth, project readiness
squads doctor -v               # Verbose with install hints
squads eval engineering/scanner  # Agent readiness score
```

---

## Goals & Priorities

Goals are aspirational (in SQUAD.md). Priorities are operational (in priorities.md).

### Set Goals

```bash
squads goal set engineering "Zero CI failures on main branch"
squads goal list                    # All squads
squads goal list engineering        # Specific squad
squads goal complete engineering 1  # Mark done
squads goal progress engineering 1 "75%"
```

### Business Context

```bash
squads context                           # Full business context
squads context --squad engineering       # Squad-focused context
squads context --topic "pricing"         # Topic-focused search
squads context --json                    # Agent-consumable format
```

---

## Environment & Configuration

### Execution Environment

```bash
squads env show engineering              # View MCP servers, skills, model, budget
squads env show engineering --json       # Machine-readable
squads env prompt engineering            # Ready-to-use prompt for Claude Code
```

### Provider Management

```bash
squads providers                         # List available LLM CLI providers
```

### Sessions

```bash
squads sessions                          # Active Claude Code sessions
squads session start                     # Start new session
squads session end                       # End current session
```

---

## Autonomous Scheduling

The daemon runs agents on configured schedules without human intervention.

```bash
squads auto start                  # Start scheduling daemon
squads auto stop                   # Stop daemon
squads auto status                 # Show daemon status + next runs
squads auto pause "quota exhausted"  # Pause with reason
squads auto resume                 # Resume after pause
```

---

## Common Patterns

### Agent Self-Context (during execution)

Agents call these to understand their environment:

```bash
# What am I working with?
squads env show ${SQUAD_NAME} --json

# What do I know?
squads memory read ${SQUAD_NAME}

# What's happening across the org?
squads status --json

# What's the business context?
squads context --squad ${SQUAD_NAME} --json
```

### Post-Execution Memory Update

```bash
# Persist what you learned
squads memory write ${SQUAD_NAME} "Key finding from this run"
squads learn "Pattern discovered: X causes Y" --squad ${SQUAD_NAME} --category pattern

# Sync to remote
squads sync --push
```

### Dispatch Another Agent

```bash
# From within an agent, trigger another
squads run engineering/issue-solver --task "Fix the bug I found in #461" -b
```

### Check Before Creating

Before creating issues/PRs, check what exists:

```bash
squads status engineering -v    # See active work
squads memory read engineering  # See known issues
squads context --squad engineering --json  # Full context
```

## Full Command Reference

See `references/commands.md` for complete command listing with all flags.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `squads: command not found` | `npm install -g squads-cli` |
| No squads found | Run `squads init` to create `.agents/` |
| Agent not found | Check path: `.agents/squads/{squad}/{agent}.md` |
| Memory not persisting | Check `.agents/memory/` exists, run `squads sync` |
| Wrong provider | Set `--provider` flag or `provider:` in SQUAD.md frontmatter |
| API quota exhausted | `squads auto pause "quota"`, switch provider, or wait |
| Context too large | Use `--effort low` or reduce context layers |
