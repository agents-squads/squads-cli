# Agent Instructions

Guidance for AI coding agents working on this project.

## This Project Uses Squads

AI agents are organized into squads — domain-aligned teams defined in `.agents/squads/`.

```
.agents/
├── config/
│   └── SYSTEM.md            # Rules every agent follows
├── squads/
│   └── <squad>/
│       ├── SQUAD.md          # Squad identity, goals, output format
│       └── <agent>.md        # Agent definition
└── memory/
    └── <squad>/<agent>/      # Persistent state
```

## Before Starting Work

```bash
squads status                     # See all squads, milestones, open PRs
squads status <squad>             # Squad detail
squads memory read <squad>        # What the squad already knows
```

## During Work

- Check for existing PRs and issues before creating new ones
- Prefer editing existing files over creating new ones
- Keep changes focused — one task per commit/PR
- Use `--json` on any squads command for machine-readable output

## After Work

- Persist learnings: `squads memory write <squad> "insight"`
- Update state in `.agents/memory/<squad>/<agent>/state.md`
- Create GitHub issues for follow-up work

## Commands

```bash
squads run <squad/agent>          # Run an agent
squads status                     # Overview
squads memory read <squad>        # Recall squad knowledge
squads memory write <squad> "x"   # Persist a learning
squads env show <squad> --json    # Execution context
squads goal list                  # View squad goals
```
