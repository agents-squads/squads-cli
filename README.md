# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**CLI for managing AI agent squads** — organize, run, and track autonomous AI agents with persistent memory.

```
squads status

┌─────────────────────────────────────────────────────────────────┐
│ Squad               Agents    Memory         Last Activity      │
├─────────────────────────────────────────────────────────────────┤
│ intelligence        16        1 entries      today              │
│ research            5         1 entries      today              │
│ website             8         1 entries      today              │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# npm
npm install -g squads-cli

# Or link locally for development
cd squads-cli && npm link
```

## Quick Start

```bash
# View all squads and their status
squads status

# Run a squad
squads run website

# Search across all squad memory
squads memory query "deployment"

# Set goals for a squad
squads goal set finance "Reduce API costs by 20%"
```

## Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `squads status [squad]` | Show squad status and state |
| `squads run <target>` | Run a squad or agent |
| `squads list` | List all agents and squads |
| `squads init` | Initialize a new squad project |
| `squads dashboard` | Show comprehensive goals and metrics |

### Memory Commands

Squads maintain persistent memory across sessions:

```bash
# Search all squad memory
squads memory query "authentication"

# Search specific squad
squads memory query "pricing" --squad finance

# View squad memory
squads memory show intelligence

# Add to memory
squads memory update research "Completed competitor analysis"

# List all memory entries
squads memory list
```

### Goal Commands

Track objectives for each squad:

```bash
# Set a goal with metrics
squads goal set finance "Reduce costs" --metric "cost" --metric "savings"

# List active goals
squads goal list

# Update progress
squads goal progress finance 0 75

# Mark complete
squads goal complete finance 0
```

### Feedback Commands

Rate and improve agent performance:

```bash
# Rate last execution (1-5)
squads feedback add research 4 "Good analysis, needs more sources"

# Add learnings
squads feedback add website 5 "Great work" --learning "Always check mobile"

# View feedback history
squads feedback show research --limit 10

# Summary stats across all squads
squads feedback stats
```

### Authentication (Pro/Enterprise)

```bash
squads login      # Log in to Squads cloud
squads logout     # Log out
squads whoami     # Show current user
```

## Project Structure

```
your-project/
├── .agents/
│   ├── squads/           # Squad definitions
│   │   ├── intelligence/
│   │   │   ├── SQUAD.md  # Squad config
│   │   │   └── agents/   # Agent definitions (.md)
│   │   └── research/
│   │       └── ...
│   ├── memory/           # Persistent state per squad
│   │   ├── intelligence/
│   │   │   └── state.md
│   │   └── research/
│   │       └── state.md
│   └── outputs/          # Agent outputs
└── CLAUDE.md             # Project instructions
```

## Agent Definition

Agents are defined in markdown files:

```markdown
# Market Research Agent

## Purpose
Analyze competitor pricing and positioning.

## Model
claude-sonnet-4

## Tools
- WebSearch
- Read
- Write

## Instructions
1. Search for competitor pricing pages
2. Extract pricing tiers and features
3. Generate comparison report

## Output
Save analysis to `research/competitor-analysis.md`
```

## Integration with Claude Code

Add to your `CLAUDE.md` to auto-inject squad status at session start:

```markdown
## Session Start
Always run: `squads status`
Query memory before research: `squads memory query "<topic>"`
```

Or configure as a Claude Code hook in `.claude/settings.json`:

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

## Command Reference

```
squads status [squad]           Show squad status
  -v, --verbose                 Show detailed status

squads run <target>             Run a squad or agent
  -v, --verbose                 Verbose output
  -d, --dry-run                 Show what would run
  -e, --execute                 Execute via Claude CLI
  -a, --agent <agent>           Run specific agent

squads list                     List agents and squads
  -s, --squads                  List squads only
  -a, --agents                  List agents only

squads memory query <query>     Search squad memory
  -s, --squad <squad>           Limit to specific squad
  -a, --agent <agent>           Limit to specific agent

squads memory show <squad>      Show memory for a squad
squads memory update <squad>    Add to squad memory
  -t, --type <type>             Memory type: state|learnings|feedback
squads memory list              List all memory entries

squads goal set <squad> <desc>  Set a goal
  -m, --metric <metrics...>     Metrics to track
squads goal list [squad]        List goals
  -a, --all                     Show completed goals
squads goal progress <squad> <index> <progress>
squads goal complete <squad> <index>

squads feedback add <squad> <rating> <feedback>
  -l, --learning <learnings...>
squads feedback show <squad>
  -n, --limit <n>
squads feedback stats

squads dashboard                Show goals and metrics dashboard
squads init                     Initialize new project
squads login/logout/whoami      Authentication
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Link globally for testing
npm link
```

## License

MIT

---

Built by [Agents Squads](https://agents-squads.com) — AI systems you can learn, understand, and trust.
