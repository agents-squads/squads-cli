<div align="center">

# squads

**Your AI workforce**

One person + AI teammates = a real business.

[![npm version](https://img.shields.io/npm/v/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)

[Documentation](https://agents-squads.com/docs) · [Getting Started](https://agents-squads.com/onboarding) · [Architecture](https://agents-squads.com/engineering/squads-architecture)

</div>

---

Squads organizes AI agents into domain-aligned teams — marketing, engineering, finance, operations — that coordinate work, remember what they learn, and track goals over time. Agents are plain markdown files. No framework lock-in, no proprietary formats. Works with any LLM provider.

## Quick Start

```bash
npm install -g squads-cli
squads init
squads run engineering
```

```
$ squads status

  squads status
  ● 3 active sessions across 2 squads

  4/4 squads  |  memory: enabled

  SQUAD           AGENTS  MEMORY        ACTIVITY
  engineering     3       4 entries     today
  marketing       2       2 entries     today
  research        5       1 entry       yesterday
```

## Why Squads

**Agents are markdown files.** A squad is a directory. An agent is a `.md` file with a role, model preference, and instructions. You own everything — version it, edit it, fork it.

**Memory that persists.** Agents accumulate knowledge across sessions. Learnings survive restarts, and any agent can search the collective memory of the organization.

**Goals, not just tasks.** Set objectives at the squad level, track progress through KPIs, and get executive summaries. Squads is a business operating system, not a script runner.

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
squads providers   # List available providers
```

## Commands

### Core

| Command | Description |
|---------|-------------|
| `squads init` | Initialize project with manager agent and starter squads |
| `squads create <name>` | Create a new squad |
| `squads list` | List agents and squads |
| `squads run <target>` | Run a squad or specific agent |
| `squads run <target> --parallel` | Run all agents in a squad simultaneously |
| `squads orchestrate <squad>` | Run squad with lead agent orchestration |

### Monitoring

| Command | Description |
|---------|-------------|
| `squads status [squad]` | Squad overview and active sessions |
| `squads dash [name]` | Dashboard with goals, metrics, and git activity |
| `squads sessions` | Active AI coding sessions |
| `squads health` | Infrastructure health check |
| `squads doctor` | Check local tools, auth, and readiness |
| `squads cost` | Cost summary by squad and time period |
| `squads history` | Recent execution history |

### Memory & Learning

| Command | Description |
|---------|-------------|
| `squads memory query <q>` | Search across all agent memory |
| `squads memory write <squad> <insight>` | Persist a learning |
| `squads memory read <squad>` | View squad memory |
| `squads learn <insight>` | Quick-capture a learning |

### Goals & Automation

| Command | Description |
|---------|-------------|
| `squads goal set <squad> <goal>` | Set a squad objective |
| `squads goal list` | View all goals and progress |
| `squads autonomous start` | Start local cron-style scheduling daemon |
| `squads autopilot` | Full autopilot: watch, decide, dispatch, learn |
| `squads cognition` | Business cognition engine — beliefs, decisions, reflections |

### Configuration & Auth

| Command | Description |
|---------|-------------|
| `squads providers` | List available LLM providers |
| `squads context` | Business context for agent alignment |
| `squads deploy` | Deploy agents to the Squads platform |
| `squads update` | Check for and install updates |
| `squads login` | Authenticate with Squads platform |
| `squads whoami` | Show current auth identity |

Run `squads --help` for the full command reference, or `squads <command> --help` for detailed options.

## Project Structure

After `squads init`, your project gets a `.agents/` directory:

```
your-project/
├── .agents/
│   ├── squads/              # Squad and agent definitions (.md files)
│   ├── memory/              # Persistent state (auto-managed)
│   └── outputs/             # Agent work products
└── CLAUDE.md                # Optional: project-level AI context
```

Everything is plain text. Version it with git, review it in PRs, edit it in any editor.

## Development

```bash
git clone https://github.com/agents-squads/squads-cli.git
cd squads-cli
npm install
npm run build
npm link           # Makes 'squads' available globally
npm test
```

**Tech Stack:** TypeScript (strict mode), Commander.js, Vitest, tsup.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Community

- [GitHub Issues](https://github.com/agents-squads/squads-cli/issues) — Bug reports and feature requests
- [GitHub Discussions](https://github.com/agents-squads/squads-cli/discussions) — Questions and ideas
- [Documentation](https://agents-squads.com/docs) — Guides, tutorials, and API reference

## License

[MIT](LICENSE)

---

<div align="center">

Built by [Agents Squads](https://agents-squads.com)

</div>
