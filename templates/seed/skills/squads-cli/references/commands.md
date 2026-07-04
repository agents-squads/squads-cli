# Squads CLI — Full Command Reference

> GENERATED from `squads commands --json` (squads-cli v0.8.2) — do not edit.
> Regenerate: `npm run build && npm run gen:skill`. For the live tree on any
> installed version, run `squads commands --json` directly.

## All Commands

| Command | Description |
|---------|-------------|
| `squads init` | Plant the seed: create manager agent, CLI skill, and starter squads |
| `squads add <name>` | Add a new squad with directory structure and starter files |
| `squads run [target] [agent]` | Run a squad or agent (no target lists squads). Use --org to run all squads as one coordinated cycle. |
| `squads list` | List squads (alias for: squads status) |
| `squads pause <squad>` | Pause a squad — run/org/cron dispatch will refuse until resumed |
| `squads resume <squad>` | Resume a paused squad |
| `squads orchestrate <squad>` | Run squad with lead agent orchestration |
| `squads env show <squad>` | Show execution environment for a squad |
| `squads env prompt <squad>` | Output ready-to-use prompt for Claude Code execution |
| `squads exec list` | List recent executions |
| `squads exec show <id>` | Show execution details |
| `squads exec stats` | Show execution statistics |
| `squads log` | Show run history with timestamps, duration, and status |
| `squads dashboard [name]` | Show dashboards. Use "squads dash" for overview, "squads dash <name>" for specific dashboard, "squads dash --list" to see all. |
| `squads status [squad]` | Show squad status and state |
| `squads context` | Get business context for alignment: goals, memory, costs, activity |
| `squads cost` | Show cost summary (today, week, by squad) |
| `squads budget <squad>` | Check budget status for a squad |
| `squads usage` | Show local cost/token usage (today, rolling window, by squad) |
| `squads health` | Quick health check for all infrastructure services |
| `squads doctor` | Check local tools, auth, and project readiness |
| `squads history` | Show recent agent execution history |
| `squads results [squad]` | Show squad results: git activity + KPI goals vs actuals |
| `squads goal set <squad> <description>` | Set a goal for a squad |
| `squads goal list [squad]` | List goals for squad(s) |
| `squads goal complete <squad> <index>` | Mark a goal as completed |
| `squads goal progress <squad> <index> <progress>` | Update goal progress |
| `squads kpi list` | List all KPIs across squads |
| `squads kpi show <squad>` | Show KPI status for a squad |
| `squads kpi record <squad> <kpi> <value>` | Record a KPI value |
| `squads kpi trend <squad> <kpi>` | Show KPI trend over time |
| `squads kpi insights [squad]` | Generate insights from KPI data |
| `squads progress start <squad> <description>` | Register a new active task |
| `squads progress complete <taskId>` | Mark a task as completed |
| `squads feedback add <squad> <rating> <feedback>` | Add feedback for last execution (rating 1-5) |
| `squads feedback show <squad>` | Show feedback history |
| `squads feedback stats` | Show feedback summary across all squads |
| `squads autonomy` | Show autonomy score and confidence metrics |
| `squads autopilot` | [deprecated] Use "squads run" instead — autopilot mode when no target given |
| `squads stats [squad]` | Show agent outcome scorecards: merge rate, waste, cost per outcome |
| `squads memory query <query>` | Search across all squad memory |
| `squads memory read <squad>` | Show memory for a squad |
| `squads memory write <squad> <content>` | Add to squad memory |
| `squads memory list` | List all memory entries |
| `squads memory sync` | Sync memory from git: pull remote changes, process commits, optionally push to Postgres |
| `squads memory search <query>` | Search stored conversations (requires authentication: squads login) |
| `squads memory extract` | Extract memories from recent conversations into Engram |
| `squads learn <insight>` | Capture a learning for future sessions |
| `squads learnings show <squad>` | Show learnings for a squad |
| `squads learnings search <query>` | Search learnings across all squads |
| `squads sync` | Git memory synchronization (Postgres sync optional) |
| `squads trigger list [squad]` | List triggers |
| `squads trigger sync` | Sync SQUAD.md triggers to scheduler |
| `squads trigger fire <name>` | Manually fire a trigger |
| `squads trigger enable <name>` | Enable a trigger |
| `squads trigger disable <name>` | Disable a trigger |
| `squads trigger status` | Show scheduler status |
| `squads approval send <type>` | Send approval request to Slack |
| `squads approval list` | List approvals |
| `squads approval check <id>` | Check approval status |
| `squads approval cancel <id>` | Cancel pending approval |
| `squads autonomous start` | Start the scheduling daemon |
| `squads autonomous stop` | Stop the scheduling daemon |
| `squads autonomous status` | Show daemon status, running agents, and next runs |
| `squads autonomous pause [reason]` | Pause the daemon (e.g. quota exhausted) |
| `squads autonomous resume` | Resume a paused daemon |
| `squads sessions history` | Show session history and statistics |
| `squads sessions summary` | Show pretty session summary (auto-detects current session or pass JSON) |
| `squads session start` | Register a new session |
| `squads session stop` | End current session |
| `squads session heartbeat` | Update session heartbeat |
| `squads detect-squad` | Detect current squad based on cwd (for use in hooks) |
| `squads login` | Log in to Squads (Pro & Enterprise) |
| `squads logout` | Log out from Squads |
| `squads whoami` | Show current logged in user |
| `squads eval <target>` | Evaluate agent readiness for deployment (e.g., squads eval company/coo) |
| `squads deploy status` | Show current platform deployment status |
| `squads deploy pull` | Pull execution data and learnings from platform |
| `squads cognition brief` | Executive summary: hot beliefs + recent signals + pending decisions |
| `squads cognition beliefs` | Display world model beliefs |
| `squads cognition decisions` | Decision journal with outcome scores |
| `squads cognition reflect` | Trigger meta-cognition reflection |
| `squads contract validate` | Derive + validate every agent contract; non-zero exit on any violation |
| `squads catalog list` | List all services in the catalog |
| `squads catalog show <service>` | Show detailed info for a service |
| `squads catalog check [service]` | Run scorecard checks for a service (or all) |
| `squads release pre-check <service>` | Validate dependencies and health before deploying a service |
| `squads obs history` | Show execution history with tokens and cost |
| `squads obs cost` | Show token spend summary |
| `squads obs sync` | Backfill JSONL execution data to Postgres (Tier 2) |
| `squads tier` | Show active infrastructure tier and available services |
| `squads services up` | Start local services (Docker required) |
| `squads services down` | Stop local services |
| `squads services status` | Show running Docker containers and health |
| `squads goals` | Dashboard of all squad goals — status at a glance |
| `squads credentials create <squad>` | Create a service account and key for a squad |
| `squads credentials create-all` | Create credentials for all squads with GCP config in SQUAD.md |
| `squads credentials rotate <squad>` | Rotate a squad credential (create new key, delete old) |
| `squads credentials list` | List all squad credentials and their status |
| `squads credentials revoke <squad>` | Delete a squad service account and all keys |
| `squads review` | Post-cycle evaluation — goals, costs, blockers, founder actions |
| `squads brief` | Read recent sessions, extract founder intentions, create GitHub issues |
| `squads providers` | Show available LLM CLI providers (claude, gemini, codex, etc.) |
| `squads update` | Check for and install updates |
| `squads version` | Show version information |
| `squads runs` | List live background agent runs (pid-file inventory) |
| `squads inbox` | Everything waiting on a human decision: open PRs, stranded run branches, unreviewed run output |
| `squads scoreboard` | Executor quality-per-cost ranking from real runs (read-only, provenance-labeled) |
| `squads kill [target]` | Stop a background run gracefully (pid, squad, or squad/agent) |
| `squads commands` | List the live command tree (machine-readable with --json) |

## Options Discovery

Every command supports `--help`; most support `--json` for machine output.
The authoritative, always-current surface is `squads commands --json`.
