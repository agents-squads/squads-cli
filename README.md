# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Organize, run, and track autonomous AI agents.** Built for Claude Code.

![squads dashboard](./assets/dashboard.png)

```
$ squads status

  squads status
  ● 7 active sessions across 1 squad (claude 7)

  10/10 squads  │  memory: enabled

  ┌────────────────────────────────────────────────────────┐
  │ SQUAD           AGENTS  MEMORY        ACTIVITY         │
  ├────────────────────────────────────────────────────────┤
  │ cli             7       1 entry       today            │
  │ engineering     6       1 entry       today            │
  │ intelligence    17      1 entry       4d ago           │
  │ marketing       4       2 entries     today            │
  │ website         10      1 entry       5d ago           │
  └────────────────────────────────────────────────────────┘
```

## Why squads-cli?

AI agents are powerful individually. But real work requires coordination.

- **Squads** — Group agents by domain (engineering, research, marketing)
- **Memory** — Persistent state that survives across sessions
- **Goals** — Track objectives and measure progress
- **Sessions** — Real-time detection of running AI assistants
- **Stack** — Local infrastructure for telemetry and memory

No complex infrastructure. Just markdown files and a CLI.

## Installation

```bash
npm install -g squads-cli
```

## Quick Start

```bash
# Initialize in your project
squads init

# See what you have
squads status

# Full dashboard with goals and metrics
squads dash

# Run a squad
squads run engineering

# Search memory
squads memory query "authentication"

# Set a goal
squads goal set engineering "Ship v2.0 by Friday"
```

## Features

### Dashboard

```
$ squads dash

  squads dashboard
  ● 7 active sessions across 1 squad (claude 7)

  8/10 squads  │  404 commits  │  use -f for PRs/issues

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 35% goal progress

  ┌──────────────────────────────────────────────────────────┐
  │ SQUAD        COMMITS PRs ISSUES GOALS  PROGRESS          │
  ├──────────────────────────────────────────────────────────┤
  │ marketing    203     0   0/0    9/12   ━━━━━━━━          │
  │ website      203     0   0/0    0/1    ━━━━━━━━          │
  │ engineering  139     0   0/0    0/1    ━━━━━━━━          │
  │ cli          48      0   0/0    2/3    ━━━━━━━━          │
  └──────────────────────────────────────────────────────────┘

  Git Activity (30d)
  Last 14d: ▁▁▁▁▁▁▁▄▆▄▆▅█▂
  404 commits  │  13.5/day  │  21 active days
```

### Memory Search

```
$ squads memory query "telemetry"

  squads memory query "telemetry"

  5 results found

  ┌──────────────────────────────────────────────────┐
  │ LOCATION                    TYPE      SCORE     │
  ├──────────────────────────────────────────────────┤
  │ cli/cli-lead                state     7.2       │
  │ engineering/eng-lead        state     7.2       │
  │ marketing/marketing-lead    state     7.2       │
  └──────────────────────────────────────────────────┘

  Matches
  ◇ Telemetry pipeline COMPLETE. Dashboard showing real-time...
    └ cli/cli-lead
```

### Session Detection

Real-time detection of running AI coding assistants:

```
$ squads status

  ● 7 active sessions across 1 squad (claude 7)
```

Supports multiple tools:
- Claude Code
- Cursor
- Aider
- Gemini
- GitHub Copilot
- Sourcegraph Cody
- Continue

### Stack Management

Local Docker infrastructure for telemetry and memory:

```
$ squads stack health

  squads stack health

  ✓ postgres   healthy
  ✓ redis      healthy
  ✓ neo4j      healthy
  ✓ bridge     healthy
  ✓ langfuse   healthy
  ✓ mem0       healthy
  ✓ engram     healthy

  ● 8/8 services healthy
```

### Auto-Update

```
$ squads status

  ⬆ Update available: 0.1.2 → 0.2.0 (run `squads update`)

$ squads update
  Checking npm registry...
  ⬆ Update available: 0.1.2 → 0.2.0
  Update now? [y/N]: y
  Installing update...
  ● Updated to 0.2.0
```

## Core Concepts

### Squads = Domain-Aligned Teams

```
.agents/squads/
├── engineering/
│   ├── SQUAD.md           # Squad config + goals
│   └── ci-optimizer.md    # Agent definition
├── research/
│   ├── SQUAD.md
│   └── market-analyst.md
└── intelligence/
    └── ...
```

### Agents = Markdown Prompts

```markdown
# CI Optimizer

## Purpose
Reduce build times and optimize CI/CD pipelines.

## Model
claude-sonnet-4

## Tools
- Bash(gh:*, git:*)
- Read
- Edit

## Instructions
1. Analyze current build configuration
2. Identify slow steps
3. Implement caching strategies
4. Verify improvements
```

### Memory = Cross-Session State

```bash
# Agents accumulate knowledge
squads memory show engineering
# → "Switched to pnpm for faster installs"
# → "Build cache reduced CI time by 40%"

# Search across all squads
squads memory query "performance"
```

## Commands

### Status & Dashboard

```bash
squads status              # All squads overview
squads status engineering  # Single squad details
squads status -v           # Verbose with agent list
squads dash                # Full dashboard with goals
```

### Running Agents

```bash
squads run engineering              # Run the whole squad
squads run engineering/ci-optimizer # Run specific agent
squads run engineering --dry-run    # Preview what would run
```

### Memory Management

```bash
squads memory query "deployment"     # Semantic search
squads memory show research          # View squad memory
squads memory list                   # List all entries
squads memory sync                   # Sync from git remote
```

### Goal Tracking

```bash
squads goal set finance "Cut costs 20%"  # Set goal
squads goal list                          # View all goals
squads goal progress finance 1 75         # Update progress
squads goal complete finance 1            # Mark done
```

### Feedback Loop

```bash
squads feedback add research 4 "Good analysis"   # Rate 1-5
squads feedback show research                     # View history
squads feedback stats                             # Summary
```

### Stack Management

```bash
squads stack status        # Container health
squads stack up            # Start Docker stack
squads stack down          # Stop Docker stack
squads stack health        # Comprehensive diagnostics
squads stack logs bridge   # View container logs
```

### Updates

```bash
squads update              # Interactive update
squads update -y           # Auto-confirm
squads update -c           # Check only
```

## Claude Code Integration

### Option 1: Session Hook (Recommended)

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "squads status",
        "timeout": 10
      }]
    }]
  }
}
```

Now every Claude Code session starts with squad context.

### Option 2: CLAUDE.md Instructions

```markdown
## Squads Workflow

Before starting work:
1. Run `squads status` to see current state
2. Run `squads memory query "<topic>"` to check existing knowledge
3. After completing work, update memory via state files
```

## Project Structure

```
your-project/
├── .agents/
│   ├── squads/              # Squad definitions
│   │   ├── engineering/
│   │   │   ├── SQUAD.md     # Config + goals
│   │   │   └── *.md         # Agent definitions
│   │   └── research/
│   ├── memory/              # Persistent state
│   │   ├── engineering/
│   │   │   └── state.md
│   │   └── research/
│   └── outputs/             # Agent outputs
├── .claude/
│   └── settings.json        # Hooks config
└── CLAUDE.md                # Project instructions
```

## Command Reference

```
squads status [squad]         Show squad status
  -v, --verbose               Include agent details

squads dash                   Full dashboard with goals
  -f, --full                  Include PRs and issues

squads run <target>           Run squad or agent
  -v, --verbose               Verbose output
  -d, --dry-run               Preview only
  -e, --execute               Execute via Claude CLI

squads list                   List all squads/agents
  -s, --squads                Squads only
  -a, --agents                Agents only

squads memory query <q>       Search memory
  -s, --squad <squad>         Filter by squad
squads memory show <squad>    View squad memory
squads memory list            List all entries
squads memory sync            Sync from git remote

squads goal set <squad> <goal>
squads goal list [squad]
squads goal progress <squad> <idx> <pct>
squads goal complete <squad> <idx>

squads feedback add <squad> <rating> <text>
squads feedback show <squad>
squads feedback stats

squads stack status           Container health
squads stack up               Start Docker stack
squads stack down             Stop Docker stack
squads stack health           Comprehensive diagnostics
squads stack logs <service>   View container logs

squads update                 Interactive update
  -y, --yes                   Auto-confirm
  -c, --check                 Check only

squads init                   Initialize project
squads login/logout/whoami    Authentication (Pro)
```

## Development

```bash
git clone https://github.com/agents-squads/squads-cli
cd squads-cli
npm install
npm run build
npm link  # Test globally
```

## Related

- [agents-squads](https://github.com/agents-squads/agents-squads) — Full framework with infrastructure
- [engram](https://github.com/agents-squads/engram) — Persistent memory for AI agents

## License

[MIT](LICENSE)

---

Built by [Agents Squads](https://agents-squads.com) — AI systems you can learn, understand, and trust.
