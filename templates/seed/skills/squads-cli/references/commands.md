# Squads CLI — Full Command Reference

> GENERATED from `squads commands --json` (squads-cli v0.9.0) — do not edit.
> Regenerate: `npm run build && npm run gen:skill`. For the live tree on any
> installed version, run `squads commands --json` directly.

## All Commands

| Command | Description |
|---------|-------------|
| `squads init` | Plant the seed: create manager agent, CLI skill, and starter squads |
| `squads run [target] [agent]` | Run a squad or agent: squads run <squad>/<agent> (also: <squad> <agent>). No target lists squads; --org runs all squads as one coordinated cycle. |
| `squads pause <squad>` | Pause a squad — run/org/cron dispatch will refuse until resumed |
| `squads resume <squad>` | Resume a paused squad |
| `squads env show <squad>` | Show execution environment for a squad |
| `squads env prompt <squad>` | Output ready-to-use prompt for Claude Code execution |
| `squads dashboard [name]` | Show dashboards. Use "squads dash" for overview, "squads dash <name>" for specific dashboard, "squads dash --list" to see all. |
| `squads status [squad]` | Show squad status and state |
| `squads board` | Day-scoped execution board: tiles, live runs, executions, incoming queue |
| `squads usage` | Show local cost/token usage (today, rolling window, by squad) |
| `squads doctor` | Check local tools, auth, and project readiness |
| `squads goal set <squad> <description>` | Set a goal for a squad |
| `squads goal list [squad]` | List goals for squad(s) |
| `squads goal complete <squad> <index>` | Mark a goal as completed |
| `squads goal progress <squad> <index> <progress>` | Update goal progress |
| `squads feedback add <squad> <rating> <feedback>` | Add feedback for last execution (rating 1-5) |
| `squads feedback show <squad>` | Show feedback history |
| `squads feedback stats` | Show feedback summary across all squads |
| `squads memory query <query>` | Search across all squad memory |
| `squads memory read <squad>` | Show memory for a squad |
| `squads memory write <squad> <content>` | Add to squad memory |
| `squads memory list` | List all memory entries |
| `squads memory sync` | Sync memory from git: pull remote changes, process commits, optionally push to Postgres |
| `squads memory search <query>` | Search stored conversations (requires authentication: squads login) |
| `squads memory extract` | Extract memories from recent conversations into Engram |
| `squads login` | Log in to Squads (Pro & Enterprise) |
| `squads logout` | Log out from Squads |
| `squads whoami` | Show current logged in user |
| `squads contract validate` | Derive + validate every agent contract; non-zero exit on any violation |
| `squads brief` | Morning catch-up: delivered work, pending approvals, active agents |
| `squads config use <env>` | Switch to a named environment (local, staging, prod) |
| `squads config show` | Show current environment config and resolved URLs |
| `squads providers` | Show available LLM CLI providers (claude, gemini, codex, etc.) |
| `squads update` | Check for and install updates |
| `squads version` | Show version information |
| `squads runs` | List live background agent runs (pid-file inventory) |
| `squads inbox [action] [id]` | Everything waiting on a human decision — list, or approve/reject/defer <id> |
| `squads propose` | Draft one extra deliverable on a proposal branch you review before it lands — scoped, and never leaves your machine |
| `squads scoreboard` | Compare models and executors by quality per cost, with the source of every number shown (read-only) |
| `squads kill [target]` | Stop a background run gracefully (pid, squad, or squad/agent) |
| `squads commands` | List the live command tree (machine-readable with --json) |

## Options Discovery

Every command supports `--help`; most support `--json` for machine output.
The authoritative, always-current surface is `squads commands --json`.
