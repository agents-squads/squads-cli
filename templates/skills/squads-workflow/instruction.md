# Squads Workflow

Use this skill when working with squads-cli to maintain persistent memory, track goals, and coordinate work.

## Session Start

At session start, you'll see `squads status` output automatically. For complex tasks, run:

```bash
squads context                # Get business context, goals, decisions
squads memory query "<topic>" # Check what we already know
```

**Skip context loading for simple tasks** (typo fixes, quick questions).

## Core Commands

```bash
# Context & Status
squads context                # Business context for alignment
squads status                 # Squad overview
squads dash                   # Full dashboard

# Memory
squads memory query "<topic>" # Search memory
squads memory show <squad>    # Squad's full memory

# Goals
squads goal list              # All active goals
squads goal set <squad> "X"   # Add a goal

# Running Agents
squads run <squad>            # Run all agents in squad
squads run <squad>/<agent>    # Run specific agent
squads status                   # List all agents
```

## Workflow

### Before Research
Always check memory first to avoid re-researching:
```bash
squads memory query "topic"
```

### After Work
Update memory with what you learned by editing:
`.agents/memory/<squad>/<agent>/state.md`

### Commits
Include goal attribution when relevant:
```
feat: add user auth [goal:engineering/1]
```

## Agent Execution

When a task could be automated:
1. Check if agent exists: `squads status | grep <keyword>`
2. If yes: `squads run <squad>/<agent>`
3. If no: Create agent in `.agents/squads/<squad>/<name>.md`

## Memory Locations

- `.agents/memory/<squad>/<agent>/state.md` - Current knowledge
- `.agents/memory/<squad>/<agent>/learnings.md` - Insights over time

## Key Principle

**Memory is your cross-session brain.** Without it, every session starts fresh. With it, you build on previous work.
