---
name: squads-cli
description: Squads CLI — operate your squads through the loop; intent in, reviewed work out. TRIGGER when running squads, dispatching agents, triaging the inbox, reading/writing memory, recording feedback, or checking status/usage.
context: fork
---

# Squads CLI

`squads` runs a business loop, not just commands: you (or an agent) express **intent**, squads **execute** it as bounded runs that end in reviewable artifacts, a human **decides** in the inbox, and the outcome feeds **learning** that shapes the next cycle.

```
        INTENT                     EXECUTE                     DECIDE
  ┌─────────────────┐      ┌──────────────────────┐      ┌──────────────┐
  │ goal set        │      │ run <squad> --task   │      │ inbox        │
  │ propose (CLI    │  →   │  bounded, PR-gated   │  →   │  approve /   │ → feedback → memory
  │  drafts work)   │      │ watch · kill         │      │  reject /    │    (LEARN — shapes
  └─────────────────┘      └──────────────────────┘      │  defer       │     the next cycle)
                                                          └──────────────┘
        always-on instruments: status · dash · usage · doctor
```

Every run is **bounded** (timeout, budget), **contained** (its own git worktree), and ends in an **artifact** (a PR, a proposal branch, an inbox card) — never loose changes to your working tree.

## Who types what

**Humans need five commands.** Everything else is called by agents and automation.

| Command | When you use it |
|---------|-----------------|
| `squads status` | "What's the state of my workforce?" |
| `squads dash` | Deeper view — per-squad detail, `--ceo` for the executive summary |
| `squads inbox` | Everything waiting on YOUR decision — `approve / reject / defer <id>` |
| `squads usage` | What today cost (`--all-claude` for machine-wide across projects) |
| `squads login` | Connect cloud features (optional — everything works local-first) |

**Agents use the working verbs** — the rest of this file.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Squad** | A team of agents in `.agents/squads/{name}/` — defined by `SQUAD.md` |
| **Agent** | A markdown file (`{agent}.md`) inside a squad directory |
| **Memory** | Persistent state in `.agents/memory/` — plain markdown, survives runs, **portable to any provider** (claude, gemini, opencode, …: memory is files, not vendor state) |
| **Target** | `squad/agent` notation (e.g., `engineering/issue-solver`) |
| **Context cascade** | Layered injection: SYSTEM → strategy → goals → agent → state |
| **Inbox** | The decision surface: run outcomes, proposals, and stranded work wait there; decisions land in an append-only `reviewed.jsonl` ledger with `by:` attribution |

## File Structure

```
.agents/
├── config/SYSTEM.md              # Immutable rules (all agents)
├── squads/{squad}/
│   ├── SQUAD.md                  # Squad identity, goals, KPIs
│   └── {agent}.md                # Agent definition
└── memory/
    ├── {squad}/
    │   ├── goals.md              # Measurable targets (primary squad context)
    │   ├── feedback.md           # Last cycle evaluation
    │   └── {agent}/state.md      # Agent's persistent state
    ├── company/strategy.md       # Company strategic context (L1)
    └── daily-briefing.md         # Cross-squad context
```

---

## INTENT — tell the system what matters

```bash
squads goal set engineering "Zero CI failures on main branch"
squads goal list [squad]
squads goal complete engineering 1

# Or let the CLI draft work from repo intent (ambient):
squads propose                     # one bounded background run → proposal branch + inbox card
```

Business context for any run comes from the cascade — inspect it with:

```bash
squads context [--squad <name>] [--topic "pricing"] [--json]
```

## EXECUTE — bounded runs that end in artifacts

```bash
# The workhorse: scoped task, one branch, one PR, stops at the PR gate
squads run engineering --task "Fix squads-cli#593 — spec in the issue" -t 40

# Single agent / squad conversation
squads run engineering/issue-solver
squads run research                        # lead briefs → workers → review → converge
squads run research --dry-run              # preview without executing

# Another provider (squads is provider-agnostic)
squads run research/analyst --provider=gemini
```

Bounds and containment:

| Flag | Purpose |
|------|---------|
| `-t, --timeout <min>` | Hard per-agent timeout |
| `--cost-ceiling <usd>` | Budget cap for the conversation |
| `--max-turns <n>` | Conversation turn limit |
| `-b` / `-w` | Detached / detached with log tail |

While it runs — and if it goes wrong:

```bash
squads runs                        # live background runs
squads kill <target>               # stop one gracefully
```

If a run dies mid-work, uncommitted deliverables are auto-saved to a `squads/run-*` branch and flagged in the inbox as PARTIAL — work is never silently lost.

## DECIDE — the inbox is the human gate

```bash
squads inbox                       # everything waiting on a human, one screen
squads inbox approve <id>          # PR items: arms CI-gated auto-merge
squads inbox reject <id> "reason"  # branches: archive-tag then delete; reason → feedback
squads inbox defer <id> --until <date>
```

Decisions are recorded in `reviewed.jsonl` with who decided (`--by` for bridges acting on someone's behalf). Autonomous actors must stamp themselves — never a human who didn't look.

## LEARN — close the loop

```bash
# Rate what a run actually delivered (feeds provider/squad routing)
squads feedback add engineering 4 "PR merged clean, tests included"

# Persist knowledge for the next run
squads memory write engineering "Registry pattern: commands self-describe via commands --json"
squads memory read engineering
squads memory query "CI pipeline failures"     # search across all squads
squads sync --push                              # share memory across machines

# Executor quality-per-cost, from real outcomes
squads scoreboard
```

---

## Instruments

```bash
squads status [squad] [-v] [--json]     # workforce state
squads dash [name] [--ceo]              # dashboards
squads usage [--all-claude]             # spend: project-scoped by default, machine-wide with the flag
squads doctor [-v]                      # tools, auth, project readiness — run this first when anything fails
squads providers                        # available LLM CLI lanes
squads pause <squad> / resume <squad>   # governance: a paused squad cannot be dispatched
```

## Agent patterns (during execution)

```bash
# Orient: what am I working with, what do I know, what's the state?
squads env show ${SQUAD_NAME} --json
squads memory read ${SQUAD_NAME}
squads status --json

# Persist before you finish — memory is the only thing that survives you
squads memory write ${SQUAD_NAME} "Key finding from this run"

# Dispatch follow-up work as a bounded task, never as loose edits
squads run engineering --task "Fix the bug found in #461 — spec in issue" -b
```

Before creating issues or PRs, check what already exists: `squads status <squad> -v` + `squads memory read <squad>`.

## Command surface

The verbs above are the canonical surface. Older command names (`orchestrate`, `autopilot`, `autonomy`, `approval`, `learn`, `stats`, `cost`, `history`, …) are deprecated aliases that print their replacement. Full generated reference: `references/commands.md`; authoritative for YOUR installed version: `squads commands --json`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `squads: command not found` | `npm install -g squads-cli` |
| No squads found | Run `squads init` to create `.agents/` |
| No AI CLI installed | Init scaffolds in planning-only mode; install a provider then `squads init --force --provider <id>` |
| Agent not found | Check path: `.agents/squads/{squad}/{agent}.md` |
| Memory not persisting | Check `.agents/memory/` exists, run `squads sync` |
| API quota exhausted | Wait for the window, switch `--provider`, or `squads pause <squad>` |
| Anything else | `squads doctor -v` |
