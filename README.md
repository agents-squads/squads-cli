# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Organize, run, and track autonomous AI agents.** Built for Claude Code.

```
$ squads dash

┌────────────────────────────────────────────────────────────┐
│ SQUAD            AGENTS   MEMORY        LAST ACTIVITY      │
├────────────────────────────────────────────────────────────┤
│ intelligence     16       12 entries    today              │
│ engineering      5        8 entries     today              │
│ research         6        3 entries     yesterday          │
│ website          9        5 entries     2d ago             │
└────────────────────────────────────────────────────────────┘

Active Goals: 3 | Memory Entries: 28 | Total Agents: 36
```

## Why squads-cli?

AI agents are powerful individually. But real work requires coordination.

- **Squads** — Group agents by domain (engineering, research, marketing)
- **Memory** — Persistent state that survives across sessions
- **Goals** — Track objectives and measure progress
- **Feedback** — Rate executions to improve over time

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

# Run a squad
squads run engineering

# Search memory
squads memory query "authentication"

# Set a goal
squads goal set engineering "Ship v2.0 by Friday"
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
# → "Team prefers explicit over implicit configs"

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
squads memory update research        # Add to memory
squads memory list                   # List all entries
```

### Goal Tracking

```bash
squads goal set finance "Cut costs 20%"  # Set goal
squads goal list                          # View all goals
squads goal progress finance 75           # Update progress
squads goal complete finance              # Mark done
```

### Feedback Loop

```bash
squads feedback add research 4 "Good analysis"   # Rate 1-5
squads feedback show research                     # View history
squads feedback stats                             # Summary
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
squads memory update <squad>  Add to memory
squads memory list            List all entries

squads goal set <squad> <goal>
squads goal list [squad]
squads goal progress <squad> <pct>
squads goal complete <squad>

squads feedback add <squad> <rating> <text>
squads feedback show <squad>
squads feedback stats

squads dashboard              Full dashboard
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
