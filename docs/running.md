# Running Agents

Execution modes, local limits, and scaling.

## Three ways to run

**Single agent** — run one agent for a focused task. The agent gets its
context cascade, executes autonomously, and writes results to GitHub
and memory. This is the building block.

Three equivalent ways to target a specific agent:

```bash
squads run research/analyst           # slash notation
squads run research analyst           # space notation (same result)
squads run research -a analyst        # flag notation (same result)

squads run intelligence --task "Scan competitor pricing changes"
```

**Squad conversation** — run an entire squad as a coordinated team. The
lead briefs first, workers execute in parallel, the lead reviews outputs,
and the cycle repeats until the team converges on a result. This is where
multi-agent synergy happens.

```bash
squads run research --parallel
```

**Autonomous dispatch** — let Squads decide what to run, when, and in
what order. Autopilot reads priorities and feedback, respects phase
ordering, and manages budget constraints. This is the hands-off mode for
continuous operations.

```bash
squads autopilot --interval 30 --budget 50
```

## Local execution

Squads runs locally by default — your machine, your API keys, your
control. There's no cloud dependency for core functionality. Each agent
execution spawns a CLI process (`claude`, `gemini`, etc.) that runs
until completion. Your data never leaves your machine unless the agent
explicitly pushes to GitHub or another service you've configured.

### Local limits

| Parallel squads | Machine |
|----------------|---------|
| 2–3 | 8 GB RAM, 4 cores (laptop) |
| 4–6 | 16 GB RAM, 8 cores (workstation) |
| 8–12 | 32 GB+ RAM, 10+ cores (M-series Mac / desktop) |

*Actual capacity depends on your CPU, memory, and which providers you
use. `squads autopilot --max-parallel 3` controls concurrent executions.
Monitor with `squads sessions`.*

### Cloud scaling

Local execution works well for individuals and small teams, but it has
natural limits — your machine needs to stay running, parallel execution
is bounded by hardware, and there's no shared visibility across team
members. When you're ready to scale autonomous operations across teams,
cloud execution runs the same agents, same memory, same commands — but
on managed infrastructure instead of your laptop.
