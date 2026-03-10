# squads

**Your AI workforce.** One person + AI teammates = a real business.

[![npm version](https://img.shields.io/npm/v/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)

Squads organizes AI agents into domain-aligned teams that coordinate work, accumulate knowledge, and operate autonomously. Agents are plain markdown files — no framework lock-in, no proprietary formats. Works with Claude, Gemini, GPT, Grok, and local models.

## Why Squads

Most AI agent tools give you a single assistant. Squads gives you an **organization** — specialized teams that divide labor, share context, and improve over time.

- **Agents are markdown files.** A squad is a directory. An agent is a `.md` file with a role, model, and instructions. Version it, review it in PRs, edit it in any editor.
- **Persistent memory.** Agents write learnings as they work. Knowledge survives restarts, carries forward, and is searchable across the entire organization.
- **Multi-provider.** Route each agent to the right model: Claude for deep reasoning, Gemini for speed, GPT for breadth, local models for privacy.
- **Autonomous execution.** Agents run on schedules, respect budgets, and coordinate through a shared memory layer — not a central orchestrator.

## Quick Start

```bash
npm install -g squads-cli
squads init
squads status
```

`squads init` creates a `.agents/` directory in your project with starter squads and configures Claude Code hooks for automatic context injection.

## How It Works

Everything in Squads is a plain text file. There are three concepts:

- **`SQUAD.md`** — defines a team. Contains the squad's mission, goals, KPIs, and which agents belong to it. One per squad directory. **This file is edited by the human** to set direction.

- **`agent.md`** (e.g. `code-review.md`, `issue-solver.md`) — defines one agent. Contains a role, a model preference, and instructions for what the agent should do. When you run it, Squads launches a coding session (Claude, Gemini, etc.) with these instructions as the prompt. **This file is edited by the human** to shape behavior.

- **`memory/`** — where agents write what they learn. Execution state, learnings, past outcomes. Survives restarts, syncs via git, and is searchable across the entire organization. **This directory is written by agents** automatically.

Context cascades down: system config (shared base) → squad definition (team goals) → agent definition (unique role) → memory (runtime context). Each layer adds specificity without repeating what's above it.

```
.agents/
├── squads/
│   ├── engineering/
│   │   ├── SQUAD.md            # "Ship v2.0, reduce CI time below 3min"
│   │   ├── code-review.md      # Reviews PRs for security and style
│   │   └── issue-solver.md     # Picks up GitHub issues and writes fixes
│   └── marketing/
│       ├── SQUAD.md            # "Grow organic traffic 3x"
│       └── content-writer.md   # Writes blog posts from research data
└── memory/
    ├── engineering/             # What engineering agents have learned
    └── marketing/               # What marketing agents have learned
```

## Running Agents

There's one command with two modes: run a specific target, or run everything autonomously.

```bash
# Run one agent — launches a session with its instructions
squads run engineering/issue-solver

# Run a squad — lead briefs the team, workers execute, verifier validates
squads run engineering

# Give a directive — your priority overrides the lead's assessment
squads run engineering --task "Fix all P0 bugs before Friday"

# Daemon mode — scores all squads, dispatches work, learns, repeats forever
squads run
```

When you run a squad, agents execute in a structured loop: **scanner** checks for work (open issues, failing CI), **lead** prioritizes and delegates, **workers** execute (write code, create PRs), **verifier** validates the output. Each agent writes what it learned to memory, so the next run starts smarter.

The daemon (`squads run` with no target) combines cron schedules from `SQUAD.md` with intelligent scoring. Every minute it evaluates which routines are due. Every N minutes it scores all squads based on open issues, PR status, and past outcomes — then dispatches full squad loops, grades the results (A-F), and feeds signals into the cognition engine. It runs as a detached background process.

```bash
squads run                     # Start daemon (detached)
squads run --once --dry-run    # Preview one cycle without executing
squads run -i 15 --budget 50   # 15-min scoring interval, $50/day cap
squads run --status            # Show daemon status + scheduled routines
squads run --stop              # Stop the daemon
squads run --pause             # Pause without stopping
squads run --resume            # Resume after pause
```

## What You Can Build

Squads ships with starter templates, but the real value is building squads for your domain. Here are patterns that work:

| Pattern | Example | What Agents Do |
|---------|---------|---------------|
| **Code ops** | engineering squad | Scanner finds open issues, issue-solver writes fixes as PRs, verifier checks CI |
| **Content pipeline** | marketing squad | Researcher gathers data, writer produces drafts, SEO analyst optimizes |
| **Financial ops** | finance squad | Scanner pulls transactions, bookkeeper categorizes, verifier reconciles |
| **Quality gates** | operations squad | Scanner audits agent performance, critic reviews output quality |
| **Research** | research squad | Analyst investigates a topic, synthesizer produces intelligence briefs |
| **Site monitoring** | website squad | Tester runs automated checks, scanner finds issues, lead files bugs |

Every squad follows the same shape — **lead, scanner, worker, verifier** — but the instructions inside each `.md` file are completely different. You write the markdown, Squads handles the execution.

## Key Commands

```bash
# Run
squads run <squad>             # Run a full squad loop
squads run <squad>/<agent>     # Run a single agent
squads run                     # Start daemon (cron + scoring + cognition)
squads run --stop              # Stop daemon
squads run --status            # Show daemon status

# Monitor
squads status [squad]          # Overview of all squads
squads dash                    # Dashboard with goals, metrics, git activity
squads sessions                # Detect active AI sessions across your machine
squads cost                    # Cost summary by squad and time period
squads doctor                  # Check local tools, auth, readiness

# Memory
squads memory query "topic"    # Search across all agent memory
squads memory write squad "x"  # Persist a learning
squads memory read squad       # View squad knowledge
squads memory sync             # Sync memory with git remote

# Goals
squads goal set squad "goal"   # Set a squad objective
squads goal list               # View all goals and progress
squads results [squad]         # Git activity + KPI goals vs actuals
```

Run `squads --help` for the full command reference.

## Supported Providers

Squads doesn't run models directly — it orchestrates existing CLI tools. Each provider is a coding assistant CLI that agents are dispatched to:

| Provider | CLI | Models |
|----------|-----|--------|
| Anthropic | `claude` | Opus, Sonnet, Haiku |
| Google | `gemini` | Gemini 2.5 Flash, Pro |
| OpenAI | `codex` | GPT-4o, o1, o3 |
| Mistral | `vibe` | Large, Medium |
| xAI | `grok` | Grok |
| Aider | `aider` | Multi-model |
| Ollama | `ollama` | Any local model |

```bash
squads run research --provider=google --model=gemini-2.5-flash
squads providers    # List which CLIs are installed
```

## Prerequisites

Install the tools your squads need:

| Tool | Required | Used For |
|------|----------|----------|
| [Node.js](https://nodejs.org) >= 18 | Yes | Runtime |
| [Git](https://git-scm.com) | Yes | Memory sync, version control |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Yes (default provider) | Agent execution |
| [GitHub CLI](https://cli.github.com) (`gh`) | Recommended | Issue tracking, PRs, project management |
| [Google Cloud CLI](https://cloud.google.com/sdk) (`gcloud`) | Optional | GCP deployment, secrets |
| [Docker](https://www.docker.com) | Optional | Local Postgres/Redis for API |

## Claude Code Integration

Squads hooks into Claude Code so every session starts with squad context and syncs memory when it ends:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [
        { "type": "command", "command": "squads status", "timeout": 10 },
        { "type": "command", "command": "squads memory sync --no-push", "timeout": 15 }
      ]
    }],
    "Stop": [{
      "hooks": [
        { "type": "command", "command": "squads memory sync --push", "timeout": 15 }
      ]
    }]
  }
}
```

`squads init` configures this automatically.

## Development

```bash
git clone https://github.com/agents-squads/squads-cli.git
cd squads-cli
npm install
npm run build
npm link       # Makes 'squads' available globally
npm test
```

TypeScript (strict mode), Commander.js, Vitest, tsup. Built on the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-node) with multi-provider abstraction.

## Contributing

Contributions welcome. Open an issue first to discuss changes.

1. Fork the repository
2. Create your branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Community

- [GitHub Issues](https://github.com/agents-squads/squads-cli/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/agents-squads/squads-cli/discussions) — Questions and ideas
- [Website](https://agents-squads.com) — Documentation and guides

## Related

- [agents-squads](https://github.com/agents-squads/agents-squads) — The framework
- [engram](https://github.com/agents-squads/engram) — Persistent memory for AI agents (MCP server)

## License

[MIT](LICENSE)
