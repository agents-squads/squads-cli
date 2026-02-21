# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-agents--squads.com-purple)](https://agents-squads.com/docs)

**Build your AI workforce.** Organize AI agents into domain-aligned squads -- marketing, engineering, finance, operations -- that actually get work done.

[Documentation](https://agents-squads.com/docs) | [Getting Started](https://agents-squads.com/onboarding) | [Architecture](https://agents-squads.com/engineering/squads-architecture)

## Install

```bash
npm install -g squads-cli
```

## Quick Start

```bash
# Initialize in your project
squads init

# See your squads
squads status

# Run a squad
squads run engineering

# Full dashboard
squads dash
```

After `squads init`, your project gets a `.agents/` directory with example squads, agents, and memory -- all plain markdown files you own and control.

## What It Does

Squads organizes AI agents by business domain. Each agent is a markdown file with a role, model, and instructions. Agents remember what they learn across sessions and work toward goals you set.

- **No lock-in** -- agents are markdown files, not code
- **Multi-provider** -- works with Claude, GPT-4, Gemini, Ollama, and more
- **Persistent memory** -- state survives across sessions
- **Goal tracking** -- set objectives, measure progress
- **CLI-first** -- zero code to start, `npm install -g` and go

![squads dashboard](./assets/dashboard.png)

## Core Commands

```bash
# Status & Dashboard
squads status                   # Overview of all squads
squads dash                     # Full dashboard with goals and metrics
squads dash --ceo               # Executive summary

# Running Agents
squads run <squad>              # Run an entire squad
squads run <squad>/<agent>      # Run a specific agent
squads run <squad> --parallel   # Run all agents in parallel

# Memory
squads memory query "topic"     # Search across all memory
squads memory show <squad>      # View a squad's memory
squads learn "insight"          # Capture a learning

# Goals
squads goal set <squad> "Goal"  # Set a goal
squads goal list                # View all goals

# Monitoring
squads live                     # Interactive dashboard (like htop)
squads top                      # Live process table
squads workers                  # Show active sessions
```

Run `squads --help` for the full command list.

## Project Structure

```
your-project/
├── .agents/
│   ├── squads/             # Squad definitions (markdown)
│   │   ├── engineering/
│   │   │   ├── SQUAD.md    # Squad config + goals
│   │   │   └── *.md        # Agent definitions
│   │   └── marketing/
│   ├── memory/             # Persistent state (auto-managed)
│   └── outputs/            # Agent outputs
├── .claude/
│   └── settings.json       # Optional hooks config
└── CLAUDE.md
```

## Claude Code Integration

Add hooks to `.claude/settings.json` so every session starts with context:

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

## Development

```bash
git clone https://github.com/agents-squads/squads-cli
cd squads-cli
npm install
npm run build
npm link
npm test
```

## Resources

- [Documentation](https://agents-squads.com/docs) -- full CLI reference and tutorials
- [Getting Started](https://agents-squads.com/onboarding) -- setup guide
- [Architecture](https://agents-squads.com/engineering/squads-architecture) -- how squads work
- [Hooks and Skills](https://agents-squads.com/engineering/hooks-and-skills) -- Claude Code integration
- [agents-squads](https://github.com/agents-squads/agents-squads) -- full framework
- [engram](https://github.com/agents-squads/engram) -- persistent memory for AI agents

## License

[MIT](LICENSE)

---

Built by [Agents Squads](https://agents-squads.com) -- your AI workforce.
