# Architecture

How Squads works under the hood: files, context, roles, and the feedback loop.

## Everything is a file

There's no database, no server, no runtime to manage. Your entire AI
workforce lives in a single `.agents/` directory that you commit to git
like any other code. This means you get version history, code review,
branching, and merge — applied to your agent definitions and
organizational memory.

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

## Context Cascade

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

## Role-Based Depth

Not every agent needs the same depth of context. A scanner looking for
new opportunities doesn't need to know the company's strategic directives
or what feedback other agents received. A lead coordinating across squads
needs everything. Loading unnecessary context wastes tokens and can
confuse the agent with irrelevant information.

- **Scanners** get identity, priorities, and their own state — they discover, don't decide
- **Workers** add directives, feedback, and active work — they execute with awareness of what exists
- **Leads** get all layers including cross-squad briefings — they orchestrate with full visibility
- **Evaluators** get all layers with org-wide summaries — they assess and generate feedback

## Goals vs Priorities

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

## Phase Ordering

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

## The Feedback Loop

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
