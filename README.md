# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-agents--squads.com-purple)](https://agents-squads.com/docs)

**Build your AI workforce.** Organize AI agents into domain-aligned squads that run your business — finance, marketing, engineering, operations.

```bash
npm install -g squads-cli && squads init
```

> A full business team costs $1M+/year. An AI workforce costs API calls. Squads gives agents persistent memory, goals, and coordinated execution. Your agents, your data, no lock-in. Works with Claude, GPT-4, Gemini, and more.

## Quick Start

```bash
squads init          # Initialize in your project
squads status        # See your squads
squads dash          # Full dashboard with goals
squads run marketing # Run a squad
```

That's it. Four commands to go from zero to running agents.

## Key Features

- **Squads** — Group agents by domain (engineering, research, marketing)
- **Memory** — Persistent state that survives across sessions
- **Goals** — Track objectives and measure progress
- **Sessions** — Real-time detection of running AI assistants
- **Hooks** — Inject context at session start, sync memory at session end
- **Dashboard** — CEO-mode executive summaries, git activity, KPIs

No complex infrastructure. Just markdown files and a CLI.

## How It Works

```
your-project/
├── .agents/
│   ├── squads/              # Squad definitions (markdown)
│   │   ├── engineering/
│   │   │   ├── SQUAD.md     # Config + goals
│   │   │   └── ci-lead.md   # Agent definition
│   │   └── marketing/
│   ├── memory/              # Persistent state
│   └── outputs/             # Agent outputs
├── .claude/
│   └── settings.json        # Hook config
└── CLAUDE.md
```

Agents are markdown files. Squads are folders. Memory persists in git.

## Essential Commands

```bash
# Status & monitoring
squads status [squad]        # Squad overview
squads dash                  # Full dashboard
squads dash --ceo            # Executive summary

# Running agents
squads run <squad>           # Run a squad
squads run <squad> -a <agent> # Run specific agent
squads run <squad> --parallel # All agents in parallel

# Memory
squads memory query "topic"  # Search across all memory
squads memory show <squad>   # View squad memory
squads learn "insight"       # Capture a learning

# Goals
squads goal set <squad> "Goal text"
squads goal list
```

See the full [command reference](https://agents-squads.com/docs) for all options.

## Claude Code Integration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "squads status", "timeout": 10 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "squads memory sync", "timeout": 15 }]
    }]
  }
}
```

Every session starts with squad context and ends with memory synced.

## Development

```bash
git clone https://github.com/agents-squads/squads-cli
cd squads-cli
npm install && npm run build && npm link
```

```bash
npm test              # Run tests
npm run dev           # Watch mode
npm run lint          # ESLint
npm run typecheck     # TypeScript check
```

## Documentation

- [Getting Started](https://agents-squads.com/onboarding)
- [Full Documentation](https://agents-squads.com/docs)
- [Architecture Guide](https://agents-squads.com/engineering/squads-architecture)
- [Hooks & Skills](https://agents-squads.com/engineering/hooks-and-skills)
- [Cost Management](https://agents-squads.com/engineering/cost-management)

**Related:** [agents-squads](https://github.com/agents-squads/agents-squads) | [engram](https://github.com/agents-squads/engram)

## License

[MIT](LICENSE)

---

Built by [Agents Squads](https://agents-squads.com) — your AI workforce.
