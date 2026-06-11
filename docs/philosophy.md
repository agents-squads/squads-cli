# Philosophy

Why Squads exists, and why it's a CLI.

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

## Who uses this CLI

`squads run` is called by an orchestrating agent — Claude Code, Gemini,
or any supported CLI. After dispatch, **agents are the primary users of
this CLI**. They call `squads memory read` to recall what they know,
`squads env show --json` to understand their execution context, and
`squads status --json` to see what's happening across the org.

The CLI is designed for both human operators and machine consumers —
every command supports `--json` for programmatic access. Human-facing
commands (like `squads dash`) prioritize readability. Agent-facing
commands (like `squads env prompt`) prioritize composability.

## Context is the moat

Most agent frameworks focus on tool calling. Squads focuses on **what the
agent knows before it starts working**.

Every agent execution loads a layered context cascade — squad identity,
current priorities, feedback from last cycle, active work across the team —
tuned by role so scanners stay lightweight and leads get the full picture.

The desired result: agents that don't duplicate work, don't ignore
feedback, and improve with every cycle.

See [Architecture](architecture.md) for how the cascade works.

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
| [Node.js](https://nodejs.org) >= 20 | Runtime |
| [Git](https://git-scm.com) | Memory sync, version control |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Default agent execution |

### Recommended

| Tool | Purpose |
|------|---------|
| [GitHub CLI](https://cli.github.com) (`gh`) | Issue tracking, PRs, project management |
| [Google Cloud CLI](https://cloud.google.com/sdk) (`gcloud`) | GCP deployments, secrets, infrastructure |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`wrangler`) | Cloudflare Workers, Pages, DNS |
| [Google Workspace CLI](https://github.com/nicholasgasior/gws) (`gws`) | Drive, Gmail, Calendar, Sheets |

### Any CLI your agents need

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
