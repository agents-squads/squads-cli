# Squads CLI — Full Command Reference

## All Commands

| Command | Description |
|---------|-------------|
| `squads init` | Create `.agents/` directory with starter squads |
| `squads add <name>` | Add a new squad with directory structure |
| `squads run [target]` | Run squad, agent, or autopilot (no target = autopilot) |
| `squads orchestrate <squad>` | Run squad with lead agent orchestration |
| `squads status [squad]` | Show squad status and state |
| `squads env show <squad>` | View execution environment (MCP, skills, model) |
| `squads env prompt <squad>` | Output ready-to-use prompt for execution |
| `squads context` | Get business context for alignment |
| `squads dashboard [name]` | Show dashboards (`squads dash` alias) |
| `squads exec list` | List recent executions |
| `squads exec show <id>` | Show execution details |
| `squads exec stats` | Show execution statistics |
| `squads cost` | Show cost summary (today, week, by squad) |
| `squads budget <squad>` | Check budget status for a squad |
| `squads health` | Quick health check for infrastructure |
| `squads doctor` | Check local tools, auth, project readiness |
| `squads history` | Show recent agent execution history |
| `squads results [squad]` | Show git activity + KPI goals vs actuals |
| `squads goal set <squad> <desc>` | Set a goal for a squad |
| `squads goal list [squad]` | List goals |
| `squads goal complete <squad> <i>` | Mark goal completed |
| `squads goal progress <squad> <i> <p>` | Update goal progress |
| `squads kpi` | Track and analyze squad KPIs |
| `squads progress` | Track active and completed agent tasks |
| `squads feedback` | Record and view execution feedback |
| `squads autonomy` | Show autonomy score and confidence metrics |
| `squads stats [squad]` | Agent outcome scorecards: merge rate, waste |
| `squads memory query <q>` | Search across all squad memory |
| `squads memory read <squad>` | Show memory for a squad |
| `squads memory write <squad> <content>` | Add to squad memory |
| `squads memory list` | List all memory entries |
| `squads memory sync` | Sync memory from git |
| `squads memory search <q>` | Search stored conversations (requires login) |
| `squads memory extract` | Extract memories from recent conversations |
| `squads learn <insight>` | Capture a learning for future sessions |
| `squads learnings` | View and search learnings |
| `squads sync` | Git memory synchronization |
| `squads trigger` | Manage smart triggers |
| `squads approval` | Manage approval requests |
| `squads auto start` | Start autonomous scheduling daemon |
| `squads auto stop` | Stop scheduling daemon |
| `squads auto status` | Show daemon status and next runs |
| `squads auto pause [reason]` | Pause daemon |
| `squads auto resume` | Resume paused daemon |
| `squads sessions` | Show active Claude Code sessions |
| `squads session` | Manage current session lifecycle |
| `squads detect-squad` | Detect squad from cwd (for hooks) |
| `squads login` | Log in to Squads platform |
| `squads logout` | Log out |
| `squads whoami` | Show current user |
| `squads eval <target>` | Evaluate agent readiness |
| `squads deploy` | Deploy agents to Squads platform |
| `squads cognition` | Business cognition engine |
| `squads providers` | Show available LLM CLI providers |
| `squads update` | Check for and install updates |
| `squads version` | Show version information |

## `squads run` — Full Options

```
squads run [target] [options]

Target formats:
  (none)                    Autopilot mode
  <squad>                   Squad conversation
  <squad>/<agent>           Single agent
  <squad> -a <agent>        Single agent (flag notation)

Agent execution:
  -v, --verbose             Detailed output
  -d, --dry-run             Preview without executing
  -t, --timeout <min>       Timeout in minutes (default: 30)
  -b, --background          Run detached
  -w, --watch               Run detached but tail logs
  --task <directive>        Founder directive
  --effort <level>          high | medium | low
  --skills <ids...>         Additional skills to load
  --provider <provider>     anthropic | google | openai | mistral | xai | aider | ollama
  --model <model>           opus | sonnet | haiku | gemini-2.5-flash | gpt-4o | etc.
  --cloud                   Dispatch to cloud worker
  --no-verify               Skip post-execution verification
  --no-eval                 Skip COO evaluation
  --use-api                 Use API credits instead of subscription

Squad conversation:
  -p, --parallel            All agents in parallel (tmux)
  -l, --lead                Single orchestrator with Task tool
  --max-turns <n>           Max conversation turns (default: 20)
  --cost-ceiling <usd>      Cost ceiling in USD (default: 25)

Autopilot:
  -i, --interval <min>      Minutes between cycles (default: 30)
  --max-parallel <count>    Max parallel squad loops (default: 2)
  --budget <usd>            Daily budget cap (default: 0 = unlimited)
  --once                    Single cycle then exit
  --phased                  Use depends_on phase ordering

Output:
  -j, --json                Machine-readable output
```

## `squads init` — Full Options

```
squads init [options]

  -p, --provider <provider>  LLM provider (claude, gemini, openai, ollama, none)
  --pack <packs...>          Additional squads: engineering, marketing, operations, all
  --skip-infra               Skip infrastructure setup
  --force                    Skip requirement checks
  -y, --yes                  Accept defaults (non-interactive)
  -q, --quick                Files only, skip prompts
```

## `squads memory` — Full Options

```
squads memory query <query>           Search all memory
squads memory read <squad>            Show squad memory
squads memory write <squad> <content> Write to memory
  --agent <agent>                     Target specific agent
squads memory list                    List all entries
squads memory sync [options]          Sync from git
  --push                              Also push changes
squads memory search <query>          Search conversations (requires login)
squads memory extract                 Extract from recent conversations
```

## `squads context` — Full Options

```
squads context [options]

  -s, --squad <squad>     Focus on specific squad
  -t, --topic <topic>     Search memory for topic
  -a, --agent             JSON for agent consumption
  -j, --json              JSON output
  -v, --verbose           Additional details
```

## Global Patterns

Every command supports:
- `--json` or `-j` for machine-readable output
- `--verbose` or `-v` for detailed output
- `--help` or `-h` for usage information

## SQUAD.md Frontmatter

Squads are configured via YAML frontmatter in SQUAD.md:

```yaml
---
name: engineering
repo: my-org/engineering
provider: anthropic
model: opus
effort: high
depends_on: [data]
kpis:
  merge_rate:
    target: ">80%"
    unit: percentage
---
```

| Field | Purpose |
|-------|---------|
| `name` | Squad identifier |
| `repo` | GitHub repo (org/repo format) |
| `provider` | Default LLM provider |
| `model` | Default model |
| `effort` | Default effort level |
| `depends_on` | Phase ordering dependencies |
| `kpis` | KPI definitions for tracking |
