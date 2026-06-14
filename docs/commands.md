# Commands

The command surface is split into two audiences. Human operators manage
the workforce — they set goals, monitor progress, and control budgets.
Agents consume the CLI programmatically during execution — they read
their own context, persist learnings, and record metrics. Every command
supports `--json` so agents can parse outputs reliably.

## For Humans

```bash
# Setup
squads init                    # Bootstrap .agents/ directory
squads add <name>              # Add a new squad
squads doctor                  # Check tools and readiness

# Execute
squads run <squad/agent>       # Run an agent or full squad
squads autonomous start        # Start the scheduling daemon (reads SQUAD.md routines)
squads autonomous stop         # Stop the daemon
squads autonomous status       # Show daemon status, running agents, next runs

# Squad lifecycle
squads pause <squad>           # Pause a squad (run/org/cron will refuse until resumed)
squads resume <squad>          # Resume a paused squad

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

## For Agents

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

## Pause and Resume

Pause a squad to prevent it from being dispatched by `squads run`, org cycles,
and the autonomous daemon. The squad definition is preserved — only execution
is blocked.

```bash
# Pause a squad (optionally with a reason)
squads pause engineering
squads pause engineering --reason "waiting for design sign-off"

# Resume a paused squad
squads resume engineering

# Force-run a paused squad (bypasses the pause guard)
squads run engineering --force
```

**Options**

| Command | Option | Description |
|---------|--------|-------------|
| `pause` | `-r, --reason <text>` | Record why the squad is paused |
| `pause` | `-j, --json` | Machine-readable output |
| `resume` | `-j, --json` | Machine-readable output |

**Behavior when a squad is paused**

- `squads run <squad>` exits with an error and shows the pause reason
- `squads run --org` silently skips the squad
- The autonomous daemon skips scheduled routines for the squad
- `squads status` marks the squad as `paused`
- All state, memory, and goals are preserved

Resume with `squads resume <squad>` to restore normal dispatch.

Everything above works locally — no login, no cloud, no API.
Every command supports `--json` for machine consumption.

Run `squads --help` for the full command tree.
