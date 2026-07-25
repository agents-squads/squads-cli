# Commands

The CLI surface has 70+ commands split into two audiences. **Human operators** manage
the workforce — they set goals, monitor progress, and control budgets.
**Agents** consume the CLI programmatically during execution — they read
their own context, persist learnings, and record metrics. Every command
supports `--json` so agents can parse outputs reliably.

The authoritative reference is always `squads commands --json` — it prints
the live command tree from the Commander.js registry and can never drift
from what the binary actually accepts.

---

## For Humans

### Setup

```bash
squads init                    # Bootstrap .agents/ directory
squads add <name>              # Add a new squad
squads doctor                  # Check tools and readiness
squads providers               # Show available LLM CLI providers (claude, gemini, codex, etc.)
```

| Command | Key flags |
|---------|-----------|
| `init` | `-p, --provider <provider>`, `--pack <packs...>`, `--skip-infra`, `--force`, `-y, --yes`, `-q, --quick` |
| `add` | `-d, --description <text>`, `-g, --goal <text>`, `-m, --model <model>`, `-f, --force`, `-y, --yes`, `-r, --repo` |
| `doctor` | `-v, --verbose` |
| `providers` | `-j, --json` |

### Execute

```bash
squads run <squad/agent>       # Run an agent or full squad
squads orchestrate <squad>     # Start a lead-coordinated multi-agent session
squads eval <target>           # Evaluate agent readiness for deployment
squads propose                 # Draft one extra deliverable on a proposal branch
```

`run` is the primary dispatch command. It supports several execution modes:

| Mode | How | Description |
|------|-----|-------------|
| Squad conversation | `squads run engineering` | Orchestrator lead spawns workers, reviews output |
| Direct agent | `squads run engineering/code-review` | Run one agent directly |
| Parallel | `squads run engineering --parallel` | One tmux session per agent |
| Lead mode | `squads run engineering --lead` | Single orchestrator using Task tool |
| Background | `squads run engineering -b` | Detached process, check with `squads runs` |
| Background+watch | `squads run engineering -w` | Background but tail log |
| Cloud dispatch | `squads run engineering --cloud` | Via API; unavailable until `SQUADS_AUTH_URL` is set (`squads login`) |
| Org cycle | `squads run --org` | All squads run as a coordinated cycle |
| Autopilot | `squads run` (no target) | Continuous autonomous cycles |

Key `--run` flags: `-a, --agent`, `-t, --timeout <min>`, `--task <directive>`, `--provider <provider>`, `--model <model>`, `--max-turns <n>`, `--cost-ceiling <usd>`, `--focus <mode>`, `--resume`, `-i, --interval <min>`, `--budget <usd>`.

### Squad Lifecycle

```bash
squads pause <squad>           # Prevent a squad from dispatching
squads resume <squad>          # Re-enable a paused squad
```

| Command | Key flags |
|---------|-----------|
| `pause` | `-r, --reason <text>`, `-j, --json` |
| `resume` | `-j, --json` |

### Automation

```bash
squads autonomous start        # Start the scheduling daemon (reads SQUAD.md routines)
squads autonomous stop         # Stop the daemon
squads autonomous status       # Show daemon status, running agents, next runs
squads trigger list [squad]    # List smart triggers
squads trigger sync            # Sync SQUAD.md triggers to scheduler
squads trigger fire <name>     # Manually fire a trigger
squads trigger enable <name>   # Enable a trigger
squads trigger disable <name>  # Disable a trigger
squads trigger status          # Show scheduler status
squads approval send <type>    # Send an approval request to Slack
squads approval list           # List pending approvals
squads approval check <id>     # Check a specific approval's status
squads approval cancel <id>    # Cancel a pending approval
```

### Monitor

```bash
squads status [squad]          # Overview of all squads
squads sessions                # Active agent sessions on your machine
squads sessions history        # Session history and statistics
squads sessions summary        # Pretty session summary (or pass JSON)
squads dashboard [name]        # Show dashboards (alias: squads dash)
squads board                   # Day-scoped execution board
squads progress                # Track active and completed agent tasks
squads progress start <squad> <desc>   # Register a new active task
squads progress complete <taskId>      # Mark a task as completed (--failed for failure)
squads health                  # Quick health check for all infrastructure
```

### Observability

```bash
squads log                     # Run history with timestamps, duration, status
squads obs history             # Execution history with tokens and cost
squads obs cost                # Spend summary by squad and model
squads cost                    # Cost summary (today, week, by squad)
squads budget <squad>          # Pre-flight budget validation for a squad
squads usage                   # Local cost/token usage (sliding window)
squads report --for auditor    # Auditor evidence pack: runs, decisions, diffs, cost (md/html)
squads history                 # Recent agent execution history
squads scoreboard              # Compare models/executors by quality per cost
```

| Command | Key flags |
|---------|-----------|
| `log` | `-s, --squad`, `-a, --agent`, `-n, --limit`, `--since <date>`, `-j, --json` |
| `obs history` | `-s, --squad`, `-a, --agent`, `-n, --limit`, `--since <date>`, `--json` |
| `obs cost` | `--json` |
| `cost` | `-s, --squad`, `--json` |
| `usage` | `-w, --window <hours>`, `--all-claude`, `--json` |
| `report` | `--for <audience>`, `--period <7d\|30d\|YYYY-MM-DD..YYYY-MM-DD>`, `--format <md\|html>`, `--out <path>` |
| `history` | `-d, --days`, `-s, --squad`, `-v, --verbose`, `-j, --json` |
| `scoreboard` | `--json`, `--days <n>`, `--resolve` |

### Goals & Tracking

```bash
squads goal set <squad> "<goal>"        # Set a squad objective
squads goal list [squad]                # View all goals
squads goal complete <squad> <index>    # Mark a goal as completed
squads goal progress <squad> <index> "..."  # Update goal progress
squads goals                            # Dashboard view of all squad goals
squads kpi list                         # List all defined KPIs
squads kpi show <squad>                 # Show KPI status for a squad
squads kpi record <squad> <kpi> <val>  # Record a KPI value
squads kpi trend <squad> <kpi>         # Show KPI trend over time
squads kpi insights [squad]             # Generate insights from KPI data
squads results [squad]                  # Git activity + KPI goals vs actuals
squads stats [squad]                    # Agent outcome scorecards (merge rate, waste, cost)
squads autonomy                         # Autonomy score and confidence metrics
```

### Operations

```bash
squads runs                    # List live background agent runs
squads kill [target]           # Stop a background run gracefully
squads inbox [action] [id]     # Review queue — list, approve, reject, defer
squads config use <env>        # Switch environment (local, staging, prod)
squads config show             # Show current environment config and URLs
squads update                  # Check for and install updates
squads version                 # Show version information
squads commands                # List the live command tree (--json for machine-readable)
```

| Command | Key flags |
|---------|-----------|
| `runs` | `--json`, `--clean`, `--replay <execId>`, `--report <execId>`, `--outcome <execId>`, `--wait [runId]` |
| `kill` | `--all` |
| `inbox` | `--json`, `--reason <text>`, `--days <n>`, `--by <actor>` |
| `config use` | `-j, --json` |
| `config show` | `-j, --json` |
| `update` | `-y, --yes`, `-c, --check` |
| `commands` | `--json`, `--all` |

### System

```bash
squads login                   # Cloud login (hidden until SQUADS_AUTH_URL is set)
squads logout                  # Clear authentication
squads whoami                  # Show current logged-in user
squads session start           # Register a new session
squads session stop            # End current session
squads session heartbeat       # Update session heartbeat timestamp
squads detect-squad            # Detect current squad from cwd (for hooks)
squads services up             # Start local Docker services
squads services down           # Stop local Docker services
squads services status         # Show running services health
squads tier                    # Show infrastructure tier (1 = file-based, 2 = local services)
```

---

## Inbox

`squads inbox` lists everything waiting on a human operator — open pull
requests, stranded run branches, and runs that produced artifacts. Each
line shows an identifier you can use with the decision verbs below.

**Item types and identifiers**

| Type | Example identifier |
|------|-------------------|
| Pull request | `pr-12` |
| Stranded run branch | `branch-squads/run-x` |
| Run with artifacts | `run-exec_y` |

`run-artifacts` items are pointers only in v1 — inspect them with
`squads runs --outcome <execId>`.

**Verbs**

```bash
# Approve an item
squads inbox approve pr-12
#   - PRs: queues CI-gated squash auto-merge
#   - Branches: pushes the branch, opens a PR, queues merge
#   - Decisions are recorded in .agents/observability/reviewed.jsonl

squads inbox reject pr-12 --reason "Draft superseded by PR #15"
#   - PRs: closes with the given reason
#   - Branches: archive tag archive/<branch>, then deletes the branch
#   - Reason is written to squads feedback for the owning squad

squads inbox defer pr-12 --days 14
#   - Snooze for N days (default 7). Item resurfaces automatically
#     when the delay expires.
```

Decisions (approve/reject/defer) are written append-only to
`.agents/observability/reviewed.jsonl`. Approved and rejected items are
never hidden from the list; deferred items are hidden until their snooze
period expires.

---

## For Agents

Agents are the primary consumers of this CLI. After `squads run`
dispatches an agent, it uses these commands to understand its context,
persist knowledge, and evaluate its own work.

### Context

```bash
squads env show <squad> --json     # Execution context (MCP, model, budget)
squads env prompt <squad> -a <agent>      # Generate a ready-to-use sub-agent prompt
squads context                       # Aggregate: goals, memory, costs, activity
squads context -s <squad> --for run --agent-name <agent>  # Context manifest (L0-L6 taxonomy)
squads status --json                 # Org-wide state for coordination
```

| Command | Key flags |
|---------|-----------|
| `env show` | `--json` |
| `env prompt` | `-a, --agent`, `--json` |
| `context` | `-s, --squad`, `-t, --topic`, `--for <run\|tick\|session>`, `--agent-name <name>`, `-j, --json`, `-v, --verbose` |
| `status` | `-v, --verbose`, `-j, --json`, `-a, --all` |

### Memory

```bash
squads memory read <squad>           # Recall squad knowledge
squads memory write <squad> "x"      # Persist a learning
squads memory query "topic"          # Search across all squad memory
squads memory list                   # List all memory entries
squads memory sync                   # Sync memory from git (--postgres to DB)
squads memory search "query"         # Search stored conversations (requires login)
squads memory extract                # Extract memories from recent conversations
```

| Command | Key flags |
|---------|-----------|
| `memory write` | `-a, --agent <agent>`, `-t, --type <state\|learnings\|feedback>` |
| `memory query` | `-s, --squad`, `-a, --agent` |
| `memory sync` | `-v, --verbose`, `-p, --push`, `--postgres`, `--dimensions`, `--learnings`, `--auto-learn` |
| `memory search` | `-l, --limit`, `-r, --role`, `-i, --importance` |
| `memory extract` | `-s, --session`, `-h, --hours`, `-d, --dry-run` |

### Learning

```bash
squads learn <insight>               # Capture a learning for future sessions
squads learnings show <squad>        # View learnings for a squad
squads learnings search <query>      # Search learnings across all squads
```

| Command | Key flags |
|---------|-----------|
| `learn` | `-s, --squad`, `-c, --category`, `-t, --tags`, `--context` |
| `learnings show` | `-n, --limit`, `-c, --category`, `--tag` |
| `learnings search` | `-n, --limit` |

### Feedback Loop

```bash
squads feedback show <squad>         # Last cycle evaluation
squads feedback add <squad> <rating> "text"  # Write evaluation (rating 1-5)
squads feedback stats                # Summary across all squads
```

### Execution

```bash
squads exec list                     # Own execution history (filterable)
squads exec show <id>                # Execution details
squads exec stats                    # Execution statistics
```

| Command | Key flags |
|---------|-----------|
| `exec list` | `-s, --squad`, `-a, --agent`, `--status`, `-n, --limit`, `--json` |
| `exec show` | `--json` |
| `exec stats` | `-s, --squad`, `--json` |

### Verification

```bash
squads contract validate             # Derive + validate every agent contract (non-zero on violations)
squads contract validate --squad <name>  # Validate a single squad
squads eval <target>                 # Agent readiness scoring (untested → production)
```

### Knowledge & Catalog

```bash
squads catalog list                  # List all services in the catalog
squads catalog show <service>        # Service details
squads catalog check <service>       # Validate against scorecard
squads release pre-check <service>   # Validate dependencies before deploying
```

### Platform

```bash
squads deploy                        # Push agent definitions to the Squads platform
squads deploy status                 # Show current platform deployment status
squads deploy pull                   # Pull execution data and learnings from platform
```

### Observability (Agent-facing)

```bash
squads brief                         # Morning catchup: delivered work, pending approvals, active agents
squads review [squad]                # Post-cycle evaluation dashboard (founder + COO view)
squads credentials create <squad>    # Create GCP service account for a squad
squads credentials create-all        # Create credentials for all squads with GCP config
squads credentials list              # List all squad credentials and their status
squads credentials rotate <squad>    # Rotate a squad credential key
squads credentials revoke <squad>    # Delete a squad service account and all keys
```

---

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

---

Everything above works locally — no login, no cloud, no API.
Every command supports `--json` for machine consumption.

Run `squads commands --json` for the authoritative live command tree —
it is generated from the Commander.js registry and always reflects the
current binary's surface.
