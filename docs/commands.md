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

Everything above works locally — no login, no cloud, no API.
Every command supports `--json` for machine consumption.

Run `squads --help` for the full command tree.
