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

```
.agents/
├── config/
│   └── SYSTEM.md              # Base behavior (shared across all agents)
├── squads/
│   ├── engineering/
│   │   ├── SQUAD.md            # Squad identity, goals, KPIs
│   │   ├── code-review.md      # Agent definition
│   │   └── backend.md          # Agent definition
│   └── marketing/
│       ├── SQUAD.md
│       └── content.md
└── memory/                     # Persistent state (auto-managed)
    ├── engineering/
    └── marketing/
```

**Context cascades down:** `SYSTEM.md` (base behavior) → `SQUAD.md` (squad identity + goals) → `agent.md` (unique instructions) → `state.md` (ephemeral runtime context).

Everything is plain text. No databases, no servers, no config files beyond markdown.

## How Agents Think

Squads uses a layered context cascade to give each agent exactly the right
information for its role. Not too much (wasted tokens, confused agents),
not too little (blind execution, duplicate work).

### The Cascade

Every agent execution loads context in priority order:

| Layer | What | Why |
|-------|------|-----|
| System Protocol | Approvals, git workflow, escalation | Immutable rules every agent follows |
| Squad Identity | Mission, aspirational goals, output format | Who am I, what do I produce |
| Priorities | Current operational priorities | What to work on now (weekly) |
| Directives | Company-wide strategic overlay | What matters to the org |
| Feedback | Last cycle evaluation | What was valuable, what was noise |
| Memory | Agent state from last run | What I already know |
| Active Work | Open PRs and issues | What exists — don't duplicate |
| Briefings | Daily briefing, cross-squad context | What's happening elsewhere |

A token budget ensures context fits the model's window. Lower layers drop
gracefully when budget runs out — identity and priorities always load,
briefings drop first.

### Goals vs Priorities

Squads separates aspiration from execution:

- **Goals** live in `SQUAD.md` — atemporal, aspirational ("Zero friction first-run")
- **Priorities** live in `priorities.md` — temporal, operational ("Fix #461 this week")

`squads goal set` writes aspirational goals. Priorities are updated by leads
or founders between cycles. Both are injected — goals as squad identity,
priorities as current focus.

### Role-Based Depth

Not every agent needs the same context:

- **Scanners** get minimal context (identity + priorities + state) — they discover, don't decide
- **Workers** add directives + feedback + active work — they execute with awareness
- **Leads** get everything including cross-squad context — they orchestrate
- **Evaluators** get org-wide summaries — they assess and generate feedback

### The Feedback Loop

After each execution cycle, a lead evaluates squad outputs against goals:
what was valuable, what was noise, what to prioritize next. This evaluation
is written to `feedback.md` and injected into the next cycle — closing the
loop so agents learn from their own output quality over time.

### Phase Ordering

Squads declare dependencies in their SQUAD.md frontmatter:

```yaml
---
name: product
depends_on: [engineering, customer, research]
---
```

The CLI automatically computes execution phases via topological sort.
Squads with no dependencies run first. Squads with `depends_on: ["*"]`
run last (evaluation). Within each phase, squads run in parallel.
Use `squads run --phased` to enable phase-ordered execution.

## Running Agents

```bash
# Run a specific agent
squads run engineering/code-review

# Run with a specific directive
squads run engineering --task "Review all open PRs for security issues"

# Run a full squad conversation (lead briefs → workers iterate → convergence)
squads run engineering --parallel

# Autonomous scheduling with budget control
squads autopilot --interval 30 --budget 50
```

## Base Squads

These squads are battle-tested and produce real outputs autonomously:

| Squad | What It Does | Agents |
|-------|-------------|--------|
| **engineering** | Code review, CI/CD, infrastructure, issue resolution | lead, scanner, worker, verifier, issue-solver |
| **marketing** | Content creation, SEO, social media, brand voice | lead, writer, seo-analyst, social-scheduler |
| **finance** | Budget tracking, cost analysis, financial reporting | lead, scanner, verifier, bookkeeper |
| **operations** | Org health, agent performance, architecture gaps | lead, scanner, worker, verifier, critic |
| **research** | Deep research, competitive intelligence, domain analysis | lead, analyst, synthesizer |
| **product** | Roadmap, specs, user feedback synthesis, sprint planning | lead, scanner, worker |
| **customer** | Inbound lead qualification, CRM, onboarding | lead, scanner, worker |
| **website** | Site quality, SEO audits, content updates, testing | lead, scanner, tester |

Each squad follows a consistent pattern: **lead** (coordinates), **scanner** (monitors), **worker** (executes), **verifier** (validates).

## Key Commands

```bash
# Status & monitoring
squads status [squad]          # Overview of all squads
squads dash                    # Dashboard with goals, metrics, git activity
squads sessions                # Active AI coding sessions across your machine
squads cost                    # Cost summary by squad and period
squads doctor                  # Check local tools, auth, readiness

# Memory & learning
squads memory query "topic"    # Search across all agent memory
squads memory write squad "x"  # Persist a learning
squads memory read squad       # View squad knowledge
squads memory sync             # Sync memory with git remote

# Goals & tracking
squads goal set squad "goal"   # Set a squad objective
squads goal list               # View all goals and progress
squads results [squad]         # Git activity + KPI goals vs actuals

# Automation
squads autonomous start        # Cron-style local scheduling
squads autopilot               # Intelligent dispatch with budget control
squads cognition               # Business cognition engine (beliefs, decisions)
```

Run `squads --help` for the full command reference, or `squads <command> --help` for options.

## Supported Providers

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
squads providers    # List available providers
```

## Prerequisites

Squads orchestrates existing CLI tools. Install the ones your squads need:

| Tool | Required | Used For |
|------|----------|----------|
| [Node.js](https://nodejs.org) >= 18 | Yes | Runtime |
| [Git](https://git-scm.com) | Yes | Memory sync, version control |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Yes (default provider) | Agent execution |
| [GitHub CLI](https://cli.github.com) (`gh`) | Recommended | Issue tracking, PRs, project management |
| [Google Cloud CLI](https://cloud.google.com/sdk) (`gcloud`) | Optional | GCP deployment, secrets |
| [Google Workspace CLI](https://github.com/nicholasgasior/gws) (`gws`) | Optional | Drive, Gmail, Calendar, Sheets |
| [Docker](https://www.docker.com) | Optional | Local Postgres/Redis for API |

## Claude Code Integration

Squads hooks into Claude Code for automatic context injection:

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
