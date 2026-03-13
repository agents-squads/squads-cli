# AI Workforce Operating Manual

This project uses [Agents Squads](https://agents-squads.com) to run an AI workforce.

## Structure

```
.agents/
├── BUSINESS_BRIEF.md           # What this workforce focuses on
├── config/
│   ├── SYSTEM.md               # Rules every agent follows (Layer 0)
│   └── provider.yaml           # LLM provider config
├── squads/
│   ├── intelligence/           # Strategic synthesis squad
│   │   ├── SQUAD.md            # Mission, goals, agents
│   │   ├── intel-lead.md       # Know / Don't Know / Playbook briefs
│   │   ├── intel-eval.md       # Quality evaluation
│   │   └── intel-critic.md     # Assumption challenges
│   ├── research/               # Deep research squad
│   │   ├── SQUAD.md
│   │   ├── lead.md             # Research agenda
│   │   ├── analyst.md          # Sourced findings
│   │   └── synthesizer.md      # Synthesis reports
│   ├── product/                # Product roadmap squad
│   │   ├── SQUAD.md
│   │   ├── lead.md             # Roadmap decisions
│   │   ├── scanner.md          # Signal monitoring
│   │   └── worker.md           # Specs and PRDs
│   └── company/                # Orchestration + feedback
│       ├── SQUAD.md
│       ├── manager.md          # Coordinates all squads
│       ├── company-eval.md     # Evaluates outputs
│       └── company-critic.md   # Process improvement
├── memory/
│   ├── company/
│   │   ├── manager/state.md
│   │   └── directives.md       # Strategic overlay (Layer 3)
│   ├── research/lead/state.md
│   ├── intelligence/intel-lead/state.md
│   └── product/lead/state.md
└── skills/
    └── squads-cli/SKILL.md     # CLI operations manual
```

## Context Cascade

Every agent execution loads context in this order (higher layers always load, lower layers drop when token budget runs out):

| Layer | File | Purpose |
|-------|------|---------|
| 0 | `config/SYSTEM.md` | Immutable rules — git, memory, escalation |
| 1 | `squads/{squad}/SQUAD.md` | Mission, goals, output format |
| 2 | `memory/{squad}/priorities.md` | Current operational focus |
| 3 | `memory/company/directives.md` | Company-wide strategic overlay |
| 4 | `memory/{squad}/active-work.md` | Open PRs/issues — prevent duplication |
| 5 | `memory/{squad}/{agent}/state.md` | What the agent already knows |
| 6 | `memory/{squad}/feedback.md` | Last cycle evaluation |
| 7 | `memory/daily-briefing.md` | Cross-squad context |

## Updating Business Goals

When the human operator wants to change what the workforce focuses on, help them update these files in order:

### 1. Business Brief (what we do)
Edit `.agents/BUSINESS_BRIEF.md` — this is the root context every agent reads.
```
What does the business do? Who are the customers? What market?
What should agents research first? Who are the competitors?
```

### 2. Directives (what matters now)
Edit `.agents/memory/company/directives.md` — this overrides squad goals.
```
What is the P0 priority? What metric are we optimizing?
What constraints apply? What should agents NOT do?
```

### 3. Squad Goals (what each team does)
Edit `## Goals` in each `squads/{squad}/SQUAD.md`:
```bash
# Or use the CLI:
squads goal set intelligence "Monitor competitor X's pricing weekly"
squads goal set research "Deep dive on Y market segment"
squads goal set product "Write spec for Z feature"
```

### 4. Priorities (what to do this week)
Create or edit `.agents/memory/{squad}/priorities.md`:
```
- Fix issue #123 (blocking users)
- Research competitor's new feature launch
- Update roadmap based on last cycle's feedback
```

**Rule**: Goals are aspirational (stable). Priorities are operational (updated frequently). Directives are strategic (updated less frequently).

## For Humans

Common commands:
- `squads status` — What's happening now
- `squads dash` — Full dashboard
- `squads run research/lead` — Run a specific agent
- `squads run research --parallel` — Run the full squad
- `squads memory read <squad>` — What has the squad learned
- `squads goal list` — Business objectives

## For Agents

- Read `BUSINESS_BRIEF.md` and `directives.md` before starting work
- Read your state from `memory/{squad}/{agent}/state.md`
- Update state after every run
- Use the `squads-cli` skill for CLI operations
- Git is the coordination layer — commit everything

## Commit Signature

```
Co-Authored-By: Claude <noreply@anthropic.com>
```
