# squads-cli — Operations Manual

You have access to the `squads` CLI for managing your AI workforce.

## Execute (Daily Operations)

```bash
squads run <squad>/<agent>        # Execute a specific agent
squads run <squad> --lead         # Orchestrate full squad
squads run <squad> --parallel     # Run all agents in parallel
squads list                       # Discover squads and agents
squads exec list                  # Recent execution history
squads exec stats                 # Execution statistics
squads orchestrate <squad>        # Multi-agent coordination
squads env prompt <squad> -a <agent>  # Get agent prompt
```

## Understand (Situational Awareness)

```bash
squads dash --json                # Full dashboard (use --json for parsing)
squads status [squad]             # Quick status snapshot
squads context --json             # Business context feed
squads cost                       # Cost tracking
squads budget <squad>             # Budget check
squads history                    # Execution history
```

## Track (Objectives + Metrics)

```bash
squads goal set <squad> "<goal>"  # Set a business objective
squads goal list [squad]          # List goals
squads goal complete <squad> <n>  # Mark goal done
squads kpi list                   # List all KPIs
squads kpi show <squad>           # Squad KPIs
squads kpi trend <squad> <kpi>    # Show trend
squads feedback add <squad> <1-5> "<feedback>"  # Rate output
squads autonomy                   # Self-assessment
```

## Learn (Memory + Knowledge)

```bash
squads memory read <squad>        # Load squad memory
squads memory write <squad> "<insight>"  # Persist learning
squads memory search "<query>"    # Search all memory
squads memory list                # List all entries
squads learn "<insight>"          # Capture learning
squads learnings show <squad>     # View learnings
squads sync --push                # Sync memory to git
```

## Schedule (Automation)

```bash
squads trigger list               # View triggers
squads trigger fire <squad>       # Manual trigger
squads autonomous start           # Start scheduler
squads approval list              # Check pending approvals
```

## Decision Framework

- **Read before act**: Always `squads context --json` or `squads memory read` first
- **Track everything**: Use `goal progress`, `kpi record`, `feedback add`
- **Persist learnings**: `squads memory write` after discoveries
- **Use JSON**: Add `--json` when parsing output programmatically
- **Escalate wisely**: High cost or unclear scope → ask the human

## JSON Output

All key commands support `--json` for structured output:
```json
{
  "ok": true,
  "command": "status",
  "data": { ... },
  "error": null,
  "meta": { "duration_ms": 1230, "connected": true }
}
```

When piped (non-TTY), commands auto-output JSON.
