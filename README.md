<div align="center">

# Agents Squads

**Your AI ops teams.**

Autonomous AI agents for engineering, marketing, finance, and operations.
You make the decisions. They do the work.

[![npm version](https://img.shields.io/npm/v/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli.svg)](https://www.npmjs.com/package/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)

</div>

## Why Squads?

Agents Squads is an experimental framework that replicates how businesses
have been organized and built over decades of evolution — different
domains, specialized teams, shared goals, prioritization, pivoting, and
accumulated knowledge. The same structure that makes human organizations
effective can make AI operations effective.

LLMs are not learners. Their limitations around self-learning and memory
are well known. But this framework engineers around those limitations —
using structured context injection, persistent filesystem memory, and
feedback loops to extract the best outputs from repetitive tasks and
accumulate organizational knowledge across cycles.

AI agents from different providers — Claude, Gemini, Codex, Grok — each
have distinct strengths. Claude reasons deeply. Gemini is fast and cheap.
GPT has broad knowledge. But individually, each one hits a ceiling: no
shared context, no coordination, no way to evaluate its own output.

A **squad** puts multiple AI agents together as a team — different models,
different roles — working toward a shared goal. A Gemini scanner finds
opportunities. A Claude worker executes deep reasoning. A fast model
verifies quality. A lead coordinates and prioritizes. The synergy between
models and roles produces output no individual agent achieves alone.

Agents within a squad don't just run in parallel — they **converse**.
A lead briefs the team, workers iterate on the task, the lead reviews
and redirects, the verifier checks the output. This local conversation
loop — happening entirely on your machine through shared transcript
files — lets agents discuss, debate, and converge on a solution before
shipping anything.

This is the difference between "AI that helps" and "AI that operates."

### Who uses this CLI

`squads run` is called by an orchestrating agent — Claude Code, Gemini,
or any supported CLI. After dispatch, **agents are the primary users of
this CLI**. They call `squads memory read` to recall what they know,
`squads env show --json` to understand their execution context, and
`squads status --json` to see what's happening across the org.

The CLI is designed for both human operators and machine consumers —
every command supports `--json` for programmatic access. Human-facing
commands (like `squads dash`) prioritize readability. Agent-facing
commands (like `squads env prompt`) prioritize composability.

### Context is the moat

Most agent frameworks focus on tool calling. Squads focuses on **what the
agent knows before it starts working**.

Every agent execution loads a layered context cascade — squad identity,
current priorities, feedback from last cycle, active work across the team —
tuned by role so scanners stay lightweight and leads get the full picture.

The desired result: agents that don't duplicate work, don't ignore
feedback, and improve with every cycle.

## Quick Start

```bash
npm install -g squads-cli
squads init
squads status
```

`squads init` creates a `.agents/` directory with 4 starter squads and
configures your environment.

## How It Works

Everything in Squads is a file. There's no database, no server, no
runtime to manage. Your entire AI workforce lives in a single `.agents/`
directory that you commit to git like any other code. This means you get
version history, code review, branching, and merge — applied to your
agent definitions and organizational memory.

```
.agents/
├── BUSINESS_BRIEF.md          # Business context (primary source)
├── config/
│   └── SYSTEM.md              # Base behavior (shared across all agents)
├── squads/
│   ├── intelligence/
│   │   ├── SQUAD.md            # Squad identity, goals, KPIs
│   │   ├── scanner.md          # Agent definition
│   │   └── analyst.md          # Agent definition
│   ├── research/
│   │   ├── SQUAD.md
│   │   └── analyst.md
│   ├── product/
│   │   ├── SQUAD.md
│   │   └── scanner.md
│   └── company/
│       ├── SQUAD.md
│       └── evaluator.md        # COO — evaluates all squad outputs
└── memory/                     # Persistent state (auto-managed)
    ├── intelligence/
    ├── research/
    ├── product/
    └── company/
```

A squad is a directory. An agent is a markdown file. Edit in vim, review in
a PR, diff in git. No YAML pipelines, no JSON schemas, no DSLs.

The three top-level directories serve distinct purposes: `config/` holds
immutable rules that every agent follows regardless of squad. `squads/`
holds identity — who each agent is, what it produces, how it behaves.
`memory/` holds state — what agents have learned, what they're working on,
what feedback they've received. Identity is stable. Memory evolves.

### Context Cascade

The biggest problem with autonomous agents isn't capability — it's
context. An agent that doesn't know what's already been done will
duplicate work. An agent that doesn't know the company strategy will
optimize for the wrong thing. An agent that doesn't know its own last
output was rated as noise will keep producing noise.

Squads solves this by loading a layered context cascade before every
execution, in strict priority order:

| # | Layer | Source | Purpose |
|---|-------|--------|---------|
| 0 | System Protocol | `config/SYSTEM.md` | Immutable rules every agent follows |
| 1 | Squad Identity | `squads/{squad}/SQUAD.md` | Mission, goals, output format |
| 2 | Priorities | `memory/{squad}/priorities.md` | Current operational focus |
| 3 | Directives | `memory/company/directives.md` | Company-wide strategic overlay |
| 4 | Active Work | `memory/{squad}/active-work.md` | Open PRs and issues — prevent duplication |
| 5 | Agent State | `memory/{squad}/{agent}/state.md` | What the agent already knows |
| 6 | Feedback | `memory/{squad}/feedback.md` | Last cycle evaluation |
| 7 | Briefings | `memory/daily-briefing.md` | Cross-squad context |

The order matters. When the token budget runs out, lower layers drop
first. An agent that loses briefings still knows its mission and what
work exists. An agent that loses its identity is useless. The cascade
ensures graceful degradation — the most critical context always loads.

### Role-Based Depth

Not every agent needs the same depth of context. A scanner looking for
new opportunities doesn't need to know the company's strategic directives
or what feedback other agents received. A lead coordinating across squads
needs everything. Loading unnecessary context wastes tokens and can
confuse the agent with irrelevant information.

- **Scanners** get identity, priorities, and their own state — they discover, don't decide
- **Workers** add directives, feedback, and active work — they execute with awareness of what exists
- **Leads** get all layers including cross-squad briefings — they orchestrate with full visibility
- **Evaluators** get all layers with org-wide summaries — they assess and generate feedback

### Goals vs Priorities

A common failure mode in autonomous systems is conflating direction with
execution. An agent that only sees "Fix #461 this week" doesn't know
*why* that matters or what the bigger picture is. An agent that only sees
"Build the best developer experience" has no idea what to work on today.

Squads separates aspiration from execution:

- **Goals** live in `SQUAD.md` — atemporal, aspirational ("Zero friction first-run experience")
- **Priorities** live in `priorities.md` — temporal, operational ("Fix #461 this week")

Goals give agents purpose and judgment. Priorities give them focus. Both
are injected — goals as identity context that shapes decision-making,
priorities as immediate operational focus. `squads goal set` writes
aspirational goals. Priorities are updated between cycles by the human
operator or the evaluator agent.

### Phase Ordering

In a real organization, the research team finishes their analysis before
the product team writes the roadmap. The finance team closes the books
before the CEO reviews performance. Order matters — and when agents
execute in the wrong order, they work with stale or missing information.

Squads declare dependencies in their SQUAD.md frontmatter:

```yaml
---
name: product
depends_on: [intelligence, research]
---
```

The CLI computes execution phases via topological sort. Squads with no
dependencies run first. Squads with `depends_on: ["*"]` run last
(evaluation). Within each phase, squads run in parallel.

### The Feedback Loop

This is the core of Squads — a closed loop where agents improve autonomously:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   autopilot ──→ squads run                          │
│       ▲              │                              │
│       │              ▼                              │
│       │    intelligence ──┐                         │
│       │    research ──────┼──→ product              │
│       │                   │        │                │
│       │                   │        ▼                │
│       │                   │   company (COO)         │
│       │                   │        │                │
│       │                   │   feedback.md           │
│       │                   │        │                │
│       │                   └────────┘                │
│       │               (injected next cycle)         │
│       └─────────────────────┘                       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

After each cycle, the company evaluator assesses all squad outputs:
what was valuable, what was noise, what to prioritize next. Written to
`feedback.md` per squad and injected into the next cycle — closing the
loop so agents learn from their own output quality.

`squads autopilot` uses these evaluations to determine which squads to
run next, in what order, with what budget. The full loop: autopilot
dispatches → agents execute → evaluator writes feedback → autopilot
reads feedback → dispatches again.

## Running Agents

There are three ways to run agents, each suited for different situations.

**Single agent** — run one agent for a focused task. The agent gets its
context cascade, executes autonomously, and writes results to GitHub
and memory. This is the building block.

```bash
squads run research/analyst
squads run intelligence --task "Scan competitor pricing changes"
```

**Squad conversation** — run an entire squad as a coordinated team. The
lead briefs first, workers execute in parallel, the lead reviews outputs,
and the cycle repeats until the team converges on a result. This is where
multi-agent synergy happens.

```bash
squads run research --parallel
```

**Autonomous dispatch** — let Squads decide what to run, when, and in
what order. Autopilot reads priorities and feedback, respects phase
ordering, and manages budget constraints. This is the hands-off mode for
continuous operations.

```bash
squads autopilot --interval 30 --budget 50
```

## Starter Squads

The first experience matters. Rather than shipping an empty framework and
asking you to figure out what to build, `squads init` ships with 4 squads
designed to deliver visible output from the very first run. These aren't
demo squads — they're the foundation of an operational AI workforce.

| Squad | What It Does | Agents |
|-------|-------------|--------|
| **intelligence** | Strategic synthesis — Know / Don't Know / Playbook briefs | intel-lead, intel-eval, intel-critic |
| **research** | Market, competitor, and trend research with sourced findings | lead, analyst, synthesizer |
| **product** | Roadmap, specs, user feedback synthesis | lead, scanner, worker |
| **company** | Orchestrates squads, evaluates outputs, closes the feedback loop | manager, evaluator, goal-tracker, event-dispatcher, critic |

**Intelligence + research** produce insights. **Product** turns insights
into roadmap. **Company** evaluates everything and writes feedback — which
agents read next cycle. The loop closes automatically.

Additional squads available as packs:

```bash
squads init --pack engineering    # Add engineering squad
squads init --pack marketing      # Add marketing squad
squads init --pack all            # All available squads
```

### Build Your Own

Squads are directories. Agents are markdown files. Bring your own skills,
tools, and CLIs — anything your agents can run in a terminal becomes part
of the squad.

```bash
squads add devops -d "Infrastructure and deployment automation"
```

This creates `squads/devops/SQUAD.md` and a lead agent. Add more agents
as `.md` files, define their roles, give them access to your CLIs
(`terraform`, `kubectl`, `aws`, `docker` — whatever they need), and run:

```bash
squads run devops --parallel
```

### Customizing Your Squads

Agents read context in layers — higher layers are stable, lower layers
change often. Update them in this order:

#### 1. Business Brief (what you do)

Edit `.agents/BUSINESS_BRIEF.md` — every agent reads this before every run.
The more specific you are, the better agents perform.

```markdown
What does your business do? Who are your customers? What market?
What should agents research first? Who are your competitors?
```

#### 2. Directives (what matters now)

Edit `.agents/memory/company/directives.md` — strategic overlay that
overrides squad-level goals when there's a conflict.

```markdown
What is the #1 priority right now? What metric are you optimizing?
What constraints apply? What should agents NOT do?
```

#### 3. Squad Goals (what each team does)

Replace the generic goals in each `SQUAD.md` with goals specific to your
business:

```bash
# Or use the CLI:
squads goal set intelligence "Monitor competitor X's pricing weekly"
squads goal set research "Deep dive on Y market segment"
squads goal set product "Write spec for Z feature"
```

#### 4. Priorities (what to do this week)

Create or edit `.agents/memory/{squad}/priorities.md` — operational focus
that changes frequently:

```markdown
- Fix issue #123 (blocking users)
- Research competitor's new feature launch
- Update roadmap based on last cycle's feedback
```

**Rule**: Goals are aspirational (stable). Priorities are operational
(updated frequently). Directives are strategic (updated less frequently).

#### Agent Instructions

Each `.md` file in a squad defines an agent's behavior, output format,
and quality rules. The starter agents come with structured output formats
(tables, scoring rubrics, required sections) — modify these to match what
you actually need.

#### System Protocol

`.agents/config/SYSTEM.md` contains immutable rules all agents follow —
git workflow, memory protocol, output standards. You rarely need to change
this, but you can customize it for your team's conventions.

## Why CLI-First?

AI agents already live in the terminal. Wrapping them in a web UI or
Python runtime adds latency, complexity, and failure modes. A CLI
orchestrating CLIs is zero-overhead — and it means your agents can use
**any tool you can run in a shell**.

The more CLIs your agents have access to, the more capable your squads
become. Squads itself is just the orchestrator — the real power comes
from the tools you give your agents.

### Required

| Tool | Purpose |
|------|---------|
| [Node.js](https://nodejs.org) >= 18 | Runtime |
| [Git](https://git-scm.com) | Memory sync, version control |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Default agent execution |

### Recommended

| Tool | Purpose |
|------|---------|
| [GitHub CLI](https://cli.github.com) (`gh`) | Issue tracking, PRs, project management |
| [Google Cloud CLI](https://cloud.google.com/sdk) (`gcloud`) | GCP deployments, secrets, infrastructure |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`wrangler`) | Cloudflare Workers, Pages, DNS |
| [Google Workspace CLI](https://github.com/nicholasgasior/gws) (`gws`) | Drive, Gmail, Calendar, Sheets |

### Any CLI Your Agents Need

```bash
terraform, kubectl, docker, aws, vercel, stripe, twilio,
psql, redis-cli, curl, jq, ffmpeg, imagemagick...
```

If it runs in a terminal, your agents can use it.

### Skills + CLIs

Agents get capabilities through two layers:

- **CLIs** are the tools — `gh`, `gcloud`, `curl`, `psql`. They execute
  actions in the real world.
- **Skills** are the knowledge — markdown files that teach agents *how*
  to use those tools effectively. A BigQuery skill teaches query
  optimization patterns. A GitHub skill teaches your PR workflow. A
  deployment skill codifies your staging-to-prod pipeline.

```
.claude/skills/
├── bq/SKILL.md              # BigQuery patterns + cost optimization
├── gh/SKILL.md              # GitHub workflow + PR conventions
├── gcloud/SKILL.md          # GCP deployment procedures
└── e2e-test/SKILL.md        # Browser testing with Chrome CDP
```

Skills are injected into agent context alongside squad identity and
memory. The combination of CLI tools + domain knowledge in skills is
what turns a generic LLM into a specialized operator.

No MCP servers, no custom tool registries, no adapter layers. A skill
file + a CLI installed on your machine is all an agent needs to operate
in any domain.

`squads doctor` checks which CLIs are available on your machine.

## Commands

The command surface is split into two audiences. Human operators manage
the workforce — they set goals, monitor progress, and control budgets.
Agents consume the CLI programmatically during execution — they read
their own context, persist learnings, and record metrics. Every command
supports `--json` so agents can parse outputs reliably.

### For Humans

```bash
# Setup
squads init                    # Bootstrap .agents/ directory
squads add <name>              # Add a new squad
squads doctor                  # Check tools and readiness

# Execute
squads run <squad/agent>       # Run an agent or full squad
squads autopilot               # Autonomous scheduling with budget control

# Monitor
squads status [squad]          # Overview of all squads
squads sessions                # Active agent sessions on your machine
squads dash                    # Dashboard with goals, metrics, activity

# Goals & Tracking
squads goal set squad "goal"   # Set a squad objective
squads goal list               # View all goals
squads results [squad]         # Git activity + KPI actuals
squads stats [squad]           # Workforce scorecard + ROI
```

### For Agents

Agents are the primary consumers of this CLI. After `squads run`
dispatches an agent, it uses these commands to understand its context,
persist knowledge, and evaluate its own work.

```bash
# Context
squads env show <squad> --json # Execution context (MCP, model, budget)
squads env prompt <squad> -a <agent>  # Generate sub-agent prompt
squads status --json           # Org-wide state for coordination

# Memory
squads memory read <squad>     # Recall squad knowledge
squads memory write <squad> "x"# Persist a learning
squads memory query "topic"    # Search across all memory

# Feedback loop
squads feedback show <squad>   # Last cycle evaluation
squads feedback add <squad> <rating> "text"  # Write evaluation
squads exec list               # Own execution history
squads kpi record <squad> <kpi> <value>  # Record a metric
```

Everything above works locally — no login, no cloud, no API.
Every command supports `--json` for machine consumption.

## Configuration

Agents need API keys to execute. Squads reads secrets from a `.env` file
in your project root — the same pattern used by most Node.js and Python
projects. Each provider's CLI uses its own environment variable, so you
only need keys for the providers you actually use.

```bash
# .env — never commit this file
ANTHROPIC_API_KEY=sk-ant-...    # Required for Claude Code (default provider)
GEMINI_API_KEY=...               # Required for Gemini CLI
OPENAI_API_KEY=sk-...            # Required for Codex
GITHUB_TOKEN=ghp_...             # Recommended for gh CLI operations
```

`squads run` loads `.env` automatically before dispatching any agent.
If a required key is missing, the provider's CLI will report the error —
Squads doesn't mask or intercept auth failures. Add `.env` to your
`.gitignore` to keep secrets out of version control.

## Providers

Multi-provider support isn't just a feature — it's central to how squads
work. Different models have different strengths, costs, and speed
profiles. A squad can route its scanner to a fast, cheap model (Gemini
Flash) for high-volume monitoring, its worker to a deep reasoning model
(Claude Opus) for complex analysis, and its verifier to a mid-tier model
for cost-effective quality checks.

Squads shells out to native AI CLIs. Each provider's CLI handles auth,
context, and tool use independently — Squads just orchestrates.

| Provider | CLI | Status |
|----------|-----|--------|
| Anthropic | `claude` | Stable — primary provider |
| Google | `gemini` | Stable |
| OpenAI | `codex` | Experimental |
| Mistral | `vibe` | Experimental |
| xAI | `grok` | Experimental |
| Ollama | `ollama` | Experimental |

Experimental providers have CLI integration but haven't been extensively
tested in production. Contributions welcome — especially from teams
already using these CLIs for autonomous work.

```bash
squads run research --provider=google --model=gemini-2.5-flash
squads providers    # List available providers and install status
```

## Local Execution and Scaling

Squads runs locally by default — your machine, your API keys, your
control. There's no cloud dependency for core functionality. Each agent
execution spawns a CLI process (`claude`, `gemini`, etc.) that runs
until completion. Your data never leaves your machine unless the agent
explicitly pushes to GitHub or another service you've configured.

### Local limits

| Parallel squads | Machine |
|----------------|---------|
| 2–3 | 8 GB RAM, 4 cores (laptop) |
| 4–6 | 16 GB RAM, 8 cores (workstation) |
| 8–12 | 32 GB+ RAM, 10+ cores (M-series Mac / desktop) |

*Actual capacity depends on your CPU, memory, and which providers you
use. `squads autopilot --max-parallel 3` controls concurrent executions.
Monitor with `squads sessions`.*

### Cloud scaling

Local execution works well for individuals and small teams, but it has
natural limits — your machine needs to stay running, parallel execution
is bounded by hardware, and there's no shared visibility across team
members. When you're ready to scale autonomous operations across teams,
cloud execution runs the same agents, same memory, same commands — but
on managed infrastructure instead of your laptop.

## Development

```bash
git clone https://github.com/agents-squads/squads-cli.git
cd squads-cli
npm install
npm run build
npm link       # Makes 'squads' available globally
npm test
```

TypeScript (strict mode), Commander.js, Vitest, tsup.

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

## Get Started

```bash
npm install -g squads-cli
squads init
squads run research/analyst
```

Build your own squads. Write your own skills. Optimize for your desired
outputs. Every organization is different — Squads gives you the structure,
you bring the domain knowledge. Start with the starter squads, observe
what works, tune the context, and iterate. The agents get better as your
skills and memory accumulate.

We'd love to see what you build. Share your squads and skills in
[GitHub Discussions](https://github.com/agents-squads/squads-cli/discussions).

## License

[MIT](LICENSE)
