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

**Autonomous dispatch** — a long-lived daemon reads cron schedules defined in
each squad's `SQUAD.md` and spawns agents automatically. Paused squads are
skipped. The daemon auto-pauses after repeated spawn failures (e.g., quota
exhausted) and resumes when you clear the pause.

```bash
squads autonomous start              # Start the scheduling daemon
squads autonomous stop               # Stop the daemon
squads autonomous status             # Show daemon status + next runs
squads autonomous pause "quota hit"  # Pause manually (daemon stays running)
squads autonomous resume             # Resume after a pause
```

For timed one-off cycles rather than a persistent daemon, use `squads run`
interval flags:

```bash
squads run -i 30 --budget 50        # Autopilot: 30-minute cycles, $50/day cap
squads run --once --dry-run         # Preview one autopilot cycle
```

**Pausing an individual squad** — pause a single squad so `run`, `--org`, and
cron dispatch refuse it until you resume (distinct from pausing the whole
daemon above). Useful for parking a squad without deleting its definition; the
runner prints how to override or resume.

```bash
squads pause intelligence            # run/org/cron refuse this squad until resumed
squads resume intelligence           # re-enable dispatch
squads run intelligence --force      # run once without resuming
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
use. `SQUADS_MAX_CONCURRENT=3` controls concurrent executions for the
autonomous daemon. Monitor with `squads sessions`.*

### Cloud scaling

Local execution works well for individuals and small teams, but it has
natural limits — your machine needs to stay running, parallel execution
is bounded by hardware, and there's no shared visibility across team
members. When you're ready to scale autonomous operations across teams,
cloud execution runs the same agents, same memory, same commands — but
on managed infrastructure instead of your laptop.
