---
name: squads-learn
description: Capture learnings after completing work. Use when finishing a task, fixing a bug, discovering a pattern, or learning something worth remembering for future sessions. Helps build institutional memory.
---

# Capture Learnings

After completing work, capture what you learned so future sessions can benefit.

## When to Use

- **After fixing a bug** - What was the root cause? How did you find it?
- **After completing a feature** - What approach worked? What didn't?
- **After research** - What did you discover? What's the key insight?
- **When you notice a pattern** - Something that works consistently

## How to Capture

### Quick Learning (one-liner)

```bash
squads learn "The auth token needs to be refreshed after 1 hour, not when the API returns 401"
```

### With Context

```bash
squads learn "Always check memory before researching to avoid duplicate work" \
  --squad engineering \
  --category pattern \
  --tags "memory,research,efficiency"
```

### Categories

- `success` - Something that worked well
- `failure` - Something that didn't work (learn from mistakes)
- `pattern` - A reusable approach
- `tip` - General advice

## Workflow Integration

### End of Task

Before marking a task complete, ask yourself:
1. What worked that I should remember?
2. What didn't work that I should avoid?
3. Is there a pattern here worth capturing?

If yes to any → `squads learn "<insight>"`

### Before Similar Tasks

Check existing learnings:
```bash
squads learnings search "auth"
squads learnings show engineering --tag auth
```

## Examples

```bash
# After fixing a bug
squads learn "PostgreSQL connection pool exhaustion was caused by unclosed transactions in error paths" --category failure --tags db,postgres,connection

# After successful implementation
squads learn "Using TypeScript strict mode caught 3 type errors before runtime" --category success --tags typescript,types

# Noticing a pattern
squads learn "When context exceeds 70%, always run squads memory sync before continuing" --category pattern --tags context,memory

# General tip
squads learn "The gh CLI is faster than the GitHub API for simple operations" --category tip --tags github,cli
```

## View Learnings

```bash
squads learnings show <squad>           # Squad's learnings
squads learnings search "<query>"       # Search all learnings
squads learnings show engineering -n 5  # Last 5 for engineering
```

## Key Principle

**Learnings compound.** Each captured insight makes future sessions smarter. A 30-second `squads learn` call can save hours of re-discovery.
