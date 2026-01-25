# squads-cli

[![npm version](https://img.shields.io/npm/v/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![npm downloads](https://img.shields.io/npm/dw/squads-cli)](https://www.npmjs.com/package/squads-cli)
[![GitHub stars](https://img.shields.io/github/stars/agents-squads/squads-cli?style=social)](https://github.com/agents-squads/squads-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Open source CLI for AI agent coordination.** Organize agents into domain-aligned squads with persistent memory, goal tracking, and coordinated execution.

```bash
npm install -g squads-cli && squads init
```

> **Why squads?** AI agents are powerful alone, but real work needs coordination. Squads organizes agents by business domain, gives them persistent memory, tracks goals, and delivers outcomes—not just answers. Works with any AI coding assistant.

![squads dashboard](./assets/dashboard.png)

⭐ **If you find this useful, [star the repo](https://github.com/agents-squads/squads-cli)** — it helps others discover it!

```
$ squads status

  squads status
  ● 7 active sessions across 1 squad (claude 7)

  10/10 squads  │  memory: enabled

  ┌────────────────────────────────────────────────────────┐
  │ SQUAD           AGENTS  MEMORY        ACTIVITY         │
  ├────────────────────────────────────────────────────────┤
  │ cli             7       1 entry       today            │
  │ engineering     6       1 entry       today            │
  │ intelligence    17      1 entry       4d ago           │
  │ marketing       4       2 entries     today            │
  │ website         10      1 entry       5d ago           │
  └────────────────────────────────────────────────────────┘
```

## Why squads-cli?

| Other Frameworks | squads-cli |
|------------------|------------|
| Framework lock-in | Markdown files you own |
| Complex setup | `npm install -g` and go |
| No memory | Persistent state across sessions |
| Single agent focus | Domain-aligned teams |
| Code-heavy | CLI-first, zero code to start |

**Works with:** Claude Code, Cursor, Aider, Gemini, GitHub Copilot, and more.

## Key Features

- **Squads** — Group agents by domain (engineering, research, marketing)
- **Memory** — Persistent state that survives across sessions
- **Goals** — Track objectives and measure progress
- **Sessions** — Real-time detection of running AI assistants
- **Hooks** — Inject context at session start, sync memory at session end
- **Stack** — Optional local infrastructure for telemetry and cost tracking

No complex infrastructure. Just markdown files and a CLI.

## Installation

```bash
npm install -g squads-cli
```

## Quick Start

```bash
# Initialize in your project
squads init

# See what you have
squads status

# Full dashboard with goals and metrics
squads dash

# Run a squad
squads run engineering

# Search memory
squads memory query "authentication"

# Set a goal
squads goal set engineering "Ship v2.0 by Friday"
```

**Expected output after `squads init`:**

```
  squads init

  ✓ Created .agents/squads/ directory
  ✓ Created example squad: engineering
  ✓ Created .agents/memory/ directory

  Next steps:
  $ squads status     See your new squad
  $ squads dash       Full dashboard view
```

## Features

### Dashboard

View comprehensive metrics across all squads:

```
$ squads dash

  squads dashboard
  ● 7 active sessions across 1 squad (claude 7)

  8/10 squads  │  404 commits  │  use -f for PRs/issues

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 35% goal progress

  ┌──────────────────────────────────────────────────────────┐
  │ SQUAD        COMMITS PRs ISSUES GOALS  PROGRESS          │
  ├──────────────────────────────────────────────────────────┤
  │ marketing    203     0   0/0    9/12   ━━━━━━━━          │
  │ website      203     0   0/0    0/1    ━━━━━━━━          │
  │ engineering  139     0   0/0    0/1    ━━━━━━━━          │
  │ cli          48      0   0/0    2/3    ━━━━━━━━          │
  └──────────────────────────────────────────────────────────┘

  Git Activity (30d)
  Last 14d: ▁▁▁▁▁▁▁▄▆▄▆▅█▂
  404 commits  │  13.5/day  │  21 active days
```

**CEO Mode** provides an executive summary:

```
$ squads dash --ceo

  squads CEO Report
  2026-01-05

  ┌─────────────────────────────────────┐
  │ METRIC              VALUE           │
  ├─────────────────────────────────────┤
  │ Active Squads       8/10            │
  │ P0 Goals            3               │
  │ P1 Goals            5               │
  │ Blockers            2               │
  │ Daily Spend         $12.50 / $50    │
  └─────────────────────────────────────┘

  P0 Priorities (revenue/launch critical)
  ✗ customer Generate first consulting revenue
  ✗ website Launch public website
```

### Memory Search

```
$ squads memory query "telemetry"

  squads memory query "telemetry"

  5 results found

  ┌──────────────────────────────────────────────────┐
  │ LOCATION                    TYPE      SCORE     │
  ├──────────────────────────────────────────────────┤
  │ cli/cli-lead                state     7.2       │
  │ engineering/eng-lead        state     7.2       │
  │ marketing/marketing-lead    state     7.2       │
  └──────────────────────────────────────────────────┘

  Matches
  ◇ Telemetry pipeline COMPLETE. Dashboard showing real-time...
    └ cli/cli-lead
```

### Session Detection

Real-time detection of running AI coding assistants:

```
$ squads status

  ● 7 active sessions across 1 squad (claude 7)
```

Supports multiple tools:
- Claude Code
- Cursor
- Aider
- Gemini
- GitHub Copilot
- Sourcegraph Cody
- Continue

### Stack Management

Local Docker infrastructure for telemetry and memory:

```
$ squads stack health

  squads stack health

  ✓ postgres   healthy
  ✓ redis      healthy
  ✓ neo4j      healthy
  ✓ bridge     healthy
  ✓ langfuse   healthy
  ✓ mem0       healthy
  ✓ engram     healthy

  ● 8/8 services healthy
```

**Valid services for `squads stack logs`:**
- `postgres` - PostgreSQL database
- `redis` - Redis cache
- `neo4j` - Graph database
- `bridge` - Conversation capture API
- `langfuse` - Telemetry dashboard
- `mem0` - Memory extraction
- `engram` - Memory MCP server
- `otel` - OpenTelemetry collector

### Auto-Update

```
$ squads status

  ⬆ Update available: 0.1.2 → 0.2.0 (run `squads update`)

$ squads update
  Checking npm registry...
  ⬆ Update available: 0.1.2 → 0.2.0
  Update now? [y/N]: y
  Installing update...
  ● Updated to 0.2.0
```

## Core Concepts

### Squads = Domain-Aligned Teams

```
.agents/squads/
├── engineering/
│   ├── SQUAD.md           # Squad config + goals
│   └── ci-optimizer.md    # Agent definition
├── research/
│   ├── SQUAD.md
│   └── market-analyst.md
└── intelligence/
    └── ...
```

### Agents = Markdown Prompts

```markdown
# CI Optimizer

## Purpose
Reduce build times and optimize CI/CD pipelines.

## Model
claude-sonnet-4

## Tools
- Bash(gh:*, git:*)
- Read
- Edit

## Instructions
1. Analyze current build configuration
2. Identify slow steps
3. Implement caching strategies
4. Verify improvements
```

### Memory = Cross-Session State

Memory files are stored at `.agents/memory/<squad>/<agent>/<type>.md`:

```
.agents/memory/
├── engineering/
│   └── eng-lead/
│       ├── state.md       # Current state
│       ├── learnings.md   # Accumulated insights
│       └── feedback.md    # Execution feedback
└── research/
    └── analyst/
        └── state.md
```

```bash
# Agents accumulate knowledge
squads memory show engineering
# → "Switched to pnpm for faster installs"
# → "Build cache reduced CI time by 40%"

# Search across all squads
squads memory query "performance"
```

### Learning Loop

Capture insights that persist across sessions:

```bash
# After fixing a bug
squads learn "PostgreSQL connection pool exhaustion was caused by unclosed transactions"

# With metadata
squads learn "Always check memory before researching" --squad engineering --category pattern

# View learnings
squads learnings show engineering
squads learnings search "postgres"
```

Learnings are stored in `.agents/memory/<squad>/shared/learnings.md` and sync with `squads memory sync`.

**Categories:**
- `success` — What worked well
- `failure` — What didn't work (learn from mistakes)
- `pattern` — Reusable approach
- `tip` — General advice

**The learning loop:**
1. Session starts → hooks inject squad status + memory
2. Work happens → you solve problems, discover things
3. Session ends → Stop hook prompts "Capture learnings: squads learn..."
4. Next session → Previous learnings compound via memory queries

### Goals with Metrics

Goals can include optional metric annotations for tracking KPIs:

```bash
# Set a goal with metrics
squads goal set finance "Reduce monthly costs by 20%" --metric "cost_usd" --metric "savings_pct"

# View goals with progress
squads goal list

  finance
  ● [1] Reduce monthly costs by 20%
    └ Current: $450/mo, target: $400/mo
```

### Learning Extraction

Extract learnings from recent conversations and store in Engram:

```bash
# Extract memories from last 24 hours
squads memory extract

# Preview without storing
squads memory extract --dry-run

# Extract from specific time window
squads memory extract --hours 48
```

## Commands

### Initialization

```bash
squads init                   # Initialize project with default template
squads init -t minimal        # Use minimal template
```

### Status & Dashboard

```bash
squads status                 # All squads overview
squads status engineering     # Single squad details
squads status -v              # Verbose with agent list

squads dash                   # Full dashboard with goals (fast mode)
squads dash -f                # Include GitHub PR/issue stats (~30s slower)
squads dash --ceo             # Executive summary with priorities and blockers
squads dash -v                # Additional details
```

### Running Agents

```bash
squads run engineering                # Run the whole squad
squads run engineering/ci-optimizer   # Run specific agent (slash notation)
squads run engineering -a ci-optimizer # Run specific agent (flag notation)
squads run engineering --dry-run      # Preview what would run
squads run engineering --execute      # Execute via Claude CLI
squads run engineering --parallel     # Run all agents in parallel
squads run engineering --lead         # Lead mode: single orchestrator with Task agents
squads run engineering --foreground   # Run in foreground (no tmux)
squads run engineering --timeout 60   # Set timeout in minutes (default: 30)
```

### Memory Management

```bash
# Query (semantic search across markdown files)
squads memory query "deployment"       # Search all memory
squads memory query "auth" -s website  # Filter by squad
squads memory query "cache" -a lead    # Filter by agent

# View
squads memory show research            # View squad memory
squads memory list                     # List all entries

# Update
squads memory update cli "Fixed telemetry bug"           # Add to learnings
squads memory update cli "State: ready" -t state         # Update state
squads memory update cli "Good" -a cli-lead -t feedback  # Add feedback

# Sync (git-based)
squads memory sync                     # Pull remote, process commits
squads memory sync -v                  # Verbose output
squads memory sync -p                  # Push local changes after sync
squads memory sync --no-pull           # Skip pulling from remote

# Search (postgres via squads-bridge)
squads memory search "authentication"         # Search stored conversations
squads memory search "error" -l 20            # Limit results
squads memory search "api" -r user            # Filter by role (user/assistant/thinking)
squads memory search "bug" -i high            # Filter by importance (low/normal/high)

# Extract (conversations → Engram memories)
squads memory extract                  # Extract from last 24h
squads memory extract -h 48            # Extract from last 48h
squads memory extract -s abc123        # Extract specific session
squads memory extract -d               # Dry run (preview only)
```

### Execution History

View and analyze past agent executions:

```bash
$ squads exec list

  squads exec list

  ┌────────────────────────────────────────────────────────────────────────────────────┐
  │ AGENT                 STATUS      DURATION  TIME          ID                       │
  ├────────────────────────────────────────────────────────────────────────────────────┤
  │ cli/code-eval         ● completed 5m 30s    2h ago        exec_abc123_xyz          │
  │ website/web-lead      ◆ running   —         3h ago        exec_def456_abc          │
  └────────────────────────────────────────────────────────────────────────────────────┘
```

```bash
squads exec list                     # Recent executions
squads exec list --squad cli         # Filter by squad
squads exec list --status completed  # Filter by status
squads exec show <id>                # Execution details
squads exec stats                    # Statistics across all executions
squads exec --json                   # JSON output for programmatic access
```

### Goal Tracking

```bash
squads goal set finance "Cut costs 20%"              # Set goal
squads goal set finance "Track API usage" -m "api_calls" -m "cost_usd"  # With metrics
squads goal list                                      # View all active goals
squads goal list -a                                   # Include completed goals
squads goal list finance                              # View goals for one squad
squads goal progress finance 1 "Reduced to $400/mo"   # Update progress (index, text)
squads goal complete finance 1                        # Mark done (by index)
```

### Feedback Loop

```bash
squads feedback add research 4 "Good analysis"        # Rate 1-5 with comment
squads feedback add cli 5 "Excellent" -l "Cache key insight"  # With learning
squads feedback show research                         # View history
squads feedback show research -n 10                   # Show more entries
squads feedback stats                                 # Summary across all squads
```

### Learnings

```bash
squads learn "Insight here"                           # Capture a learning
squads learn "Pattern" -s engineering -c pattern      # With squad and category
squads learn "Tip" -t "cli,perf"                      # With tags
squads learnings show engineering                     # View squad learnings
squads learnings show engineering -n 5                # Limit results
squads learnings show engineering --category pattern  # Filter by category
squads learnings show engineering --tag perf          # Filter by tag
squads learnings search "postgres"                    # Search all learnings
```

### Session Management

```bash
# List sessions
squads sessions                        # Show active sessions
squads sessions -v                     # With session details
squads sessions -j                     # JSON output

# History
squads sessions history                # Last 7 days
squads sessions history -d 30          # Last 30 days
squads sessions history -s website     # Filter by squad
squads sessions history -j             # JSON output

# Summary
squads sessions summary                # Auto-detect current session
squads sessions summary -f data.json   # From JSON file
squads sessions summary -j             # Output as JSON

# Lifecycle (for hooks/automation)
squads session start                   # Register new session
squads session start -s engineering    # Override squad detection
squads session start -q                # Quiet mode
squads session stop                    # End current session
squads session stop -q                 # Quiet mode
squads session heartbeat               # Update session activity
squads session heartbeat -q            # Quiet mode

# Detection
squads detect-squad                    # Detect current squad from cwd
```

### Progress Tracking

```bash
squads progress                        # Show active/completed tasks
squads progress -v                     # More activity details
squads progress start engineering "Fixing CI"   # Register task
squads progress complete abc123        # Mark task completed
squads progress complete abc123 -f     # Mark as failed
```

### Results & KPIs

```bash
squads results                         # All squads, last 7 days
squads results engineering             # Single squad
squads results -d 30                   # Last 30 days
squads results -v                      # Detailed KPIs per goal
```

### Workers

```bash
squads workers                         # Show Claude sessions, tasks, dev servers
squads workers -v                      # More details
squads workers -k 12345                # Kill process by PID
```

### Issues Management

```bash
# View issues
squads issues                          # Show GitHub issues
squads issues -o my-org                # Different organization
squads issues -r repo1,repo2           # Specific repos

# Solve issues (create PRs)
squads solve-issues                    # Solve ready-to-fix issues
squads solve-issues -r hq              # Target specific repo
squads solve-issues -i 123             # Solve specific issue
squads solve-issues -d                 # Dry run
squads solve-issues -e                 # Execute with Claude CLI

# Open issues (run evaluators)
squads open-issues                     # Find new issues via evaluators
squads open-issues -s website          # Target squad
squads open-issues -a seo-critic       # Specific evaluator
squads open-issues -d                  # Dry run
squads open-issues -e                  # Execute with Claude CLI
```

### Stack Management

```bash
# Setup
squads stack init                      # Interactive setup wizard

# Status
squads stack status                    # Container health overview
squads stack health                    # Comprehensive diagnostics
squads stack health -v                 # Show logs for unhealthy services
squads stack env                       # Print export commands

# Control
squads stack up                        # Start Docker containers
squads stack down                      # Stop Docker containers
squads stack logs bridge               # View container logs
squads stack logs postgres -n 100      # Last 100 lines
```

### Tonight Mode (Autonomous Execution)

Run agents autonomously overnight with safety guardrails:

```bash
# Run intelligence squad overnight
squads tonight intelligence

# Multiple targets with cost cap
squads tonight intelligence customer/outreach --cost-cap 25

# Preview what would run
squads tonight engineering --dry-run

# Check status while running
squads tonight status

# Stop all overnight agents
squads tonight stop

# View the morning report
squads tonight report
```

**Example output:**

```
$ squads tonight intelligence customer/outreach

  squads tonight

  Config:
    Cost cap:    $50
    Stop at:     07:00
    Max retries: 3
    Targets:     intelligence, customer/outreach

  ✓ Launched 2 agent(s)

  ✓ Tonight mode active

  Monitor:
    squads tonight status  - Check progress
    squads tonight stop    - Kill all agents
    tmux ls | grep tonight - List sessions

  Logs: .agents/outputs/tonight/
```

**Safety features:**
- **Cost cap** — Automatically stops when spending limit reached (default: $50)
- **Time limit** — Stops at specified time (default: 7:00 AM)
- **Max retries** — Limits restart attempts for crashed agents (default: 3)
- **Session isolation** — Each agent runs in isolated tmux session
- **Logging** — All output captured to `.agents/outputs/tonight/`
- **Morning report** — Summary generated on completion

**Monitoring commands:**

```bash
# Check current status
squads tonight status

# Attach to a running session
tmux attach -t squads-tonight-intelligence-...

# View live logs
tail -f .agents/outputs/tonight/*.log

# Stop everything immediately
squads tonight stop
```

> **Warning**: Tonight mode uses `--dangerously-skip-permissions` which bypasses
> Claude's safety confirmations. Only use with trusted agent definitions. Review
> your agent prompts and ensure they have appropriate scope limits before running
> autonomously.

### Smart Triggers

Triggers execute agents based on conditions in PostgreSQL:

```bash
squads trigger list                    # View all triggers
squads trigger list engineering        # Filter by squad
squads trigger sync                    # Sync SQUAD.md → Postgres
squads trigger fire cost-alert         # Manually fire a trigger
squads trigger enable cost-alert       # Enable a trigger
squads trigger disable cost-alert      # Disable a trigger
squads trigger status                  # Scheduler health & stats
```

**Trigger definition in SQUAD.md:**

```yaml
triggers:
  - name: cost-alert
    agent: cost-tracker
    condition: |
      SELECT value > 100
      FROM latest_metrics
      WHERE name = 'daily_cost_usd'
    cooldown: 6 hours
    priority: 3
```

### List & Discovery

```bash
squads list                            # List all squads and agents
squads list -s                         # Squads only
squads list -a                         # Agents only
```

### Authentication (Pro & Enterprise)

```bash
squads login                           # Log in to Squads cloud
squads logout                          # Log out
squads whoami                          # Show current user
```

### Updates

```bash
squads update                          # Interactive update
squads update -y                       # Auto-confirm
squads update -c                       # Check only, don't install
```

## Command Reference

```
squads init                          Initialize project
  -t, --template <template>          Project template (default)

squads status [squad]                Show squad status
  -v, --verbose                      Include agent details

squads dash                          Full dashboard with goals
  -v, --verbose                      Show additional details
  -c, --ceo                          Executive summary with priorities
  -f, --full                         Include GitHub PR/issue stats (~30s)

squads run <target>                  Run squad or agent
  -v, --verbose                      Verbose output
  -d, --dry-run                      Preview only
  -e, --execute                      Execute via Claude CLI
  -a, --agent <agent>                Run specific agent within squad
  -t, --timeout <minutes>            Execution timeout (default: 30)
  -p, --parallel                     Run all agents in parallel
  -l, --lead                         Lead mode: single orchestrator using Task tool
  -f, --foreground                   Run in foreground (no tmux)

squads list                          List all squads/agents
  -s, --squads                       Squads only
  -a, --agents                       Agents only

squads memory query <query>          Search memory
  -s, --squad <squad>                Filter by squad
  -a, --agent <agent>                Filter by agent
squads memory show <squad>           View squad memory
squads memory update <squad> <text>  Add to memory
  -a, --agent <agent>                Specific agent (default: squad-lead)
  -t, --type <type>                  Memory type: state, learnings, feedback
squads memory list                   List all entries
squads memory sync                   Sync from git
  -v, --verbose                      Detailed output
  -p, --push                         Push after sync
  --no-pull                          Skip pulling
squads memory search <query>         Search postgres conversations
  -l, --limit <n>                    Number of results (default: 10)
  -r, --role <role>                  Filter: user, assistant, thinking
  -i, --importance <level>           Filter: low, normal, high
squads memory extract                Extract memories to Engram
  -s, --session <id>                 Specific session
  -h, --hours <n>                    Hours to look back (default: 24)
  -d, --dry-run                      Preview only

squads goal set <squad> <goal>       Set a goal
  -m, --metric <metrics...>          Metrics to track
squads goal list [squad]             List goals
  -a, --all                          Include completed
squads goal progress <squad> <idx> <text>  Update progress
squads goal complete <squad> <idx>   Mark completed

squads feedback add <squad> <1-5> <text>  Rate execution
  -l, --learning <learnings...>      Extract learnings
squads feedback show <squad>         View history
  -n, --limit <n>                    Entries to show (default: 5)
squads feedback stats                Summary across squads

squads learn <insight>               Capture a learning
  -s, --squad <squad>                Associate with squad (default: general)
  -c, --category <category>          Category: success, failure, pattern, tip
  -t, --tags <tags>                  Comma-separated tags
  --context <context>                Additional context
squads learnings show <squad>        View squad learnings
  -n, --limit <n>                    Entries to show (default: 10)
  --category <category>              Filter by category
  --tag <tag>                        Filter by tag
squads learnings search <query>      Search all learnings
  -n, --limit <n>                    Results to show (default: 10)

squads sessions                      List active sessions
  -v, --verbose                      Session details
  -j, --json                         JSON output
squads sessions history              Session history
  -d, --days <n>                     Days of history (default: 7)
  -s, --squad <squad>                Filter by squad
  -j, --json                         JSON output
squads sessions summary              Pretty session summary
  -d, --data <json>                  JSON data
  -f, --file <path>                  JSON file path
  -j, --json                         JSON output

squads session start                 Register session
  -s, --squad <squad>                Override detection
  -q, --quiet                        Suppress output
squads session stop                  End session
  -q, --quiet                        Suppress output
squads session heartbeat             Update activity
  -q, --quiet                        Suppress output

squads detect-squad                  Detect squad from cwd

squads progress                      Show task progress
  -v, --verbose                      More details
squads progress start <squad> <desc> Register task
squads progress complete <id>        Mark completed
  -f, --failed                       Mark as failed

squads results [squad]               KPI goals vs actuals
  -d, --days <n>                     Days to look back (default: 7)
  -v, --verbose                      Detailed KPIs

squads workers                       Show active workers
  -v, --verbose                      More details
  -k, --kill <pid>                   Kill process

squads context                       Business context for alignment
  -s, --squad <squad>                Focus on specific squad
  -t, --topic <topic>                Search memory for relevant context
  -v, --verbose                      Show additional details
  --json                             JSON output

squads history                       Recent agent execution history
  -d, --days <n>                     Days to look back (default: 7)
  -s, --squad <squad>                Filter by squad
  -v, --verbose                      Show cost and token details
  -j, --json                         JSON output

squads health                        Quick infrastructure health check
  -v, --verbose                      Show logs for failures
  --json                             JSON output

squads watch <command> [args]        Live refresh any command (like Unix watch)
  -n, --interval <seconds>           Refresh interval (default: 2)

squads live                          Live TUI dashboard (like htop)
  -r, --refresh <ms>                 Refresh rate (default: 1000)

squads top                           Live process table (like Unix top)

squads version                       Show version information

squads env show <squad>              Squad execution environment (MCP, model, budget)
  --json                             JSON output
squads env list                      List all squad environments
  --json                             JSON output

squads cost                          Cost summary (today, week, by squad)
  -s, --squad <squad>                Filter to specific squad
  --json                             JSON output

squads budget <squad>                Check budget status for a squad
  --json                             JSON output

squads issues                        GitHub issues
  -o, --org <org>                    Organization (default: agents-squads)
  -r, --repos <repos>                Comma-separated repos

squads solve-issues                  Solve issues with PRs
  -r, --repo <repo>                  Target repo
  -i, --issue <number>               Specific issue
  -d, --dry-run                      Preview only
  -e, --execute                      Execute with Claude

squads open-issues                   Find new issues
  -s, --squad <squad>                Target squad
  -a, --agent <agent>                Evaluator agent
  -d, --dry-run                      Preview only
  -e, --execute                      Execute with Claude

squads stack init                    Setup wizard
squads stack status                  Container health
squads stack health                  Full diagnostics
  -v, --verbose                      Show logs for failures
squads stack env                     Print exports
squads stack up                      Start containers
squads stack down                    Stop containers
squads stack logs <service>          View logs
  -n, --tail <lines>                 Lines to show (default: 50)

squads trigger list [squad]          List triggers
squads trigger sync                  Sync to scheduler
squads trigger fire <name>           Fire trigger
squads trigger enable <name>         Enable trigger
squads trigger disable <name>        Disable trigger
squads trigger status                Scheduler stats

squads exec list                     List recent executions
  -s, --squad <squad>                Filter by squad
  -a, --agent <agent>                Filter by agent
  --status <status>                  Filter: running, completed, failed
  -n, --limit <n>                    Results to show (default: 20)
  --json                             JSON output
squads exec show <id>                Execution details
  --json                             JSON output
squads exec stats                    Execution statistics
  -s, --squad <squad>                Filter by squad
  --json                             JSON output

squads tonight <targets...>          Autonomous overnight execution
  --cost-cap <usd>                   Max spend (default: $50)
  --stop-at <time>                   Stop time HH:MM (default: 07:00)
  --max-retries <n>                  Restart limit (default: 3)
  -d, --dry-run                      Preview only
  -v, --verbose                      Verbose output
squads tonight status                Check progress
squads tonight stop                  Kill all agents
squads tonight report                View morning report

squads cron sync                     Sync agent schedules to launchd (macOS)
squads cron list [squad]             List scheduled agents
squads cron status                   Show launchd status and next runs
squads cron enable <agent>           Enable an agent's schedule
squads cron disable <agent>          Disable an agent's schedule
squads cron logs [agent]             Show execution logs

squads approval send <type>          Send approval request to Slack
squads approval list                 List pending approvals
squads approval check <id>           Check approval status
squads approval cancel <id>          Cancel pending approval

squads orchestrate <squad>           Run squad with lead agent orchestration
  -f, --foreground                   Run in foreground (no tmux)

squads skill list                    List uploaded skills
squads skill upload <path>           Upload skill directory to Anthropic API
squads skill delete <id>             Delete a skill
squads skill show <id>               Show skill details
squads skill convert <agent>         Convert agent.md to SKILL.md format

squads permissions show <squad>      Show permission context for a squad
squads permissions check <squad>     Validate permissions before execution
  -a, --agent <agent>                Specify agent for context

squads slack sync                    Sync squad channels with Slack
squads slack channels                List Slack channels
squads slack test                    Test Slack connection

squads providers                     Show available LLM CLI providers
  --json                             JSON output

squads autonomy                      Show autonomy score and confidence metrics
  -s, --squad <squad>                Filter by squad
  -p, --period <period>              Period: today, week, month
  --json                             JSON output

squads kpi show <squad>              Show KPI status for a squad
squads kpi record <squad> <kpi> <value>  Record KPI value
squads kpi trend <squad> <kpi>       Show KPI trend over time
squads kpi insights <squad>          Generate AI insights from KPIs
  --json                             JSON output

squads update                        Interactive update
  -y, --yes                          Auto-confirm
  -c, --check                        Check only

squads login                         Log in (Pro)
squads logout                        Log out
squads whoami                        Show user
```

## Claude Code Integration

### Option 1: Session Hooks (Recommended)

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "squads status",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "squads memory sync && echo \"\\n💡 Capture learnings: squads learn \\\"<insight>\\\"\\n\"",
        "timeout": 15
      }]
    }]
  }
}
```

Now every Claude Code session:
- **Starts** with squad status injected
- **Ends** with memory synced and a prompt to capture learnings

### Option 2: CLAUDE.md Instructions

```markdown
## Squads Workflow

Before starting work:
1. Run `squads status` to see current state
2. Run `squads memory query "<topic>"` to check existing knowledge
3. After completing work, update memory via state files
```

## Project Structure

```
your-project/
├── .agents/
│   ├── squads/              # Squad definitions
│   │   ├── engineering/
│   │   │   ├── SQUAD.md     # Config + goals
│   │   │   └── *.md         # Agent definitions
│   │   └── research/
│   ├── memory/              # Persistent state
│   │   ├── engineering/
│   │   │   └── eng-lead/
│   │   │       ├── state.md
│   │   │       ├── learnings.md
│   │   │       └── feedback.md
│   │   └── research/
│   ├── outputs/             # Agent outputs
│   └── sessions/
│       └── history.jsonl    # Session event log
├── .claude/
│   └── settings.json        # Hooks config
└── CLAUDE.md                # Project instructions
```

## Analytics

Track token usage, costs, and API calls across your squads.

### Setup

1. **Configure your Claude plan:**
   ```bash
   export SQUADS_PLAN_TYPE=max    # $200/mo flat rate
   # or
   export SQUADS_PLAN_TYPE=usage  # pay-per-token
   ```

2. **Connect to telemetry (optional):**
   ```bash
   # Self-hosted via Docker
   cd docker && docker-compose up -d

   # Or configure external services
   export LANGFUSE_HOST=https://your-langfuse.com
   export LANGFUSE_PUBLIC_KEY=pk-...
   export LANGFUSE_SECRET_KEY=sk-...
   ```

3. **View in dashboard:**
   ```bash
   squads dash
   ```

### Metrics Tracked

- Token usage (input/output/cache)
- API costs per squad/agent
- Rate limit status
- Generation counts

## Infrastructure

Optional services that enhance squad capabilities.

### Services

| Service | Purpose |
|---------|---------|
| postgres | Session storage, trigger conditions |
| redis | Caching, rate limiting |
| otel | OpenTelemetry metrics pipeline |
| langfuse | Telemetry dashboard |
| bridge | Conversation capture API |

### Self-Hosted Setup

```bash
# Clone the infrastructure
git clone https://github.com/agents-squads/squads-infra
cd squads-infra

# Start services
docker-compose up -d

# Configure CLI
squads stack env >> ~/.zshrc
source ~/.zshrc

# Verify
squads stack health
```

### Minimal Setup (Postgres only)

```bash
# Just need triggers and session storage
docker run -d --name squads-postgres \
  -e POSTGRES_PASSWORD=squads \
  -p 5432:5432 \
  postgres:16

export SQUADS_POSTGRES_URL=postgres://postgres:squads@localhost:5432/squads
```

## Development

```bash
git clone https://github.com/agents-squads/squads-cli
cd squads-cli
npm install
npm run build
npm link  # Test globally
```

### Testing

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Scripts

```bash
npm run build         # Build with tsup
npm run dev           # Watch mode
npm run lint          # ESLint
npm run typecheck     # TypeScript check
```

## Related

- [agents-squads](https://github.com/agents-squads/agents-squads) — Full framework with infrastructure
- [engram](https://github.com/agents-squads/engram) — Persistent memory for AI agents

## License

[MIT](LICENSE)

---

Built by [Agents Squads](https://agents-squads.com) — AI systems you can learn, understand, and trust.
