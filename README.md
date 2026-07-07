<div align="center">

# Agents Squads

**Your AI ops teams.**

Autonomous AI agents for engineering, marketing, finance, and operations.
You make the decisions. They do the work.

[![npm version](https://img.shields.io/npm/v/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)

</div>

A **squad** is a team of AI agents — different models, different roles —
working toward a shared goal with persistent memory. A lead briefs the
team, workers execute, a verifier checks the output, and feedback from
each cycle is injected into the next. Everything is a markdown file in a
git repo: no database, no server, no DSL.

```bash
npm install -g squads-cli
mkdir my-workforce && cd my-workforce
git init                       # squads runs on git — it's the state and audit trail
squads init                    # scaffolds .agents/ with starter squads
squads run demo hello-world    # verify your setup end to end
squads run research/analyst    # your first real agent
```

> Claude Code must be installed and logged in (`claude /login`) before the
> first run — `squads doctor` checks both and tells you exactly what's missing.

## How it works

```
.agents/
├── BUSINESS_BRIEF.md      # Your business context — every agent reads it
├── config/SYSTEM.md       # Immutable rules shared by all agents
├── squads/                # Identity: SQUAD.md + one .md file per agent
│   ├── intelligence/
│   ├── research/
│   ├── product/
│   └── company/           # Evaluates outputs, closes the feedback loop
└── memory/                # State: strategy, goals, learnings, feedback
```

Before every run, an agent loads a **context cascade** — company strategy,
squad goals, feedback from the last cycle, active work across the
team — tuned by role so scanners stay lightweight and leads get the full
picture. Agents that know what's been done don't duplicate work; agents
that see their own feedback stop producing noise.

Squads shells out to native AI CLIs (`claude`, `gemini`, `aider`, …), so
mixed-model teams work out of the box: a cheap model scans, a deep
reasoning model builds, a mid-tier model verifies.

```bash
squads run research                             # squad conversation (plan → work → review → verify)
squads run intelligence --task "Scan X"         # directed, bounded run
squads inbox                                    # everything waiting on YOUR decision — approve / reject / defer
```

## Documentation

| | |
|---|---|
| [Philosophy](docs/philosophy.md) | Why squads, why CLI-first, skills + tools |
| [Architecture](docs/architecture.md) | Context cascade, roles, phases, the feedback loop |
| [Configuration](docs/configuration.md) | Starter squads, building your own, secrets |
| [Running Agents](docs/running.md) | Execution modes, local limits, scaling |
| [Commands](docs/commands.md) | Reference for humans and for agents |
| [Providers](docs/providers.md) | Claude, Gemini, DeepSeek, and per-agent routing |

## Requirements

[Node.js](https://nodejs.org) >= 20, [Git](https://git-scm.com), and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (default
provider — others optional). `squads doctor` checks your machine.

Everything runs locally: your machine, your API keys, your data. No
login, no cloud, no telemetry surprises.

## Development

```bash
git clone https://github.com/agents-squads/squads-cli.git
cd squads-cli
npm install
npm run build && npm link
npm test
```

TypeScript (strict mode), Commander.js, Vitest, tsup.

## Contributing

Contributions welcome — open an issue first to discuss changes. See
[CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, and
[GitHub Discussions](https://github.com/agents-squads/squads-cli/discussions)
for questions and ideas. We'd love to see what you build — share your
squads and skills.

## License

[MIT](LICENSE)
