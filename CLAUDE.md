# squads-cli

CLI for managing autonomous AI agent squads. Built for Claude Code.

## Overview

This CLI organizes AI agents into domain-aligned squads with persistent memory, goal tracking, and infrastructure management.

**Key concepts:**
- **Squads** = Domain-aligned teams (engineering, research, marketing)
- **Agents** = Markdown-defined prompts with purpose, model, tools, instructions
- **Memory** = Persistent state across sessions at `.agents/memory/<squad>/<agent>/<type>.md`
- **Goals** = Tracked objectives with optional metrics
- **Sessions** = Real-time detection of running AI assistants

## Project Structure

```
src/
├── cli.ts                    # Main entry point, all command registration
├── commands/
│   ├── dashboard.ts          # `squads dash`, `squads status`
│   ├── run.ts                # `squads run`
│   ├── memory.ts             # `squads memory *` subcommands
│   ├── goal.ts               # `squads goal *` subcommands
│   ├── sessions.ts           # `squads sessions *` subcommands
│   ├── stack.ts              # `squads stack *` infrastructure
│   ├── trigger.ts            # `squads trigger *` smart triggers
│   └── ...
├── lib/
│   ├── memory.ts             # Memory search/load/save
│   ├── sessions.ts           # Session tracking
│   ├── squad-parser.ts       # Parse SQUAD.md and agent .md files
│   ├── terminal.ts           # Colors, box drawing, formatting
│   └── ...
└── test/                     # Vitest tests
```

## CLI Commands Quick Reference

### Core Commands
```bash
squads init                   # Initialize project
squads status [squad]         # Overview of squads/agents
squads dash                   # Full dashboard with goals
squads dash --ceo             # Executive summary with priorities
squads run <target>           # Run squad or agent
squads list                   # List all squads/agents
```

### Memory (persistent state)
```bash
squads memory query "<term>"  # Semantic search
squads memory show <squad>    # View squad memory
squads memory update <squad> "<text>"  # Add to memory
squads memory list            # List all entries
squads memory sync            # Sync from git
squads memory search "<term>" # Search postgres conversations
squads memory extract         # Extract to Engram
```

### Goals
```bash
squads goal set <squad> "<goal>"  # Set goal
squads goal set <squad> "<goal>" -m "metric1" -m "metric2"  # With metrics
squads goal list              # View active goals
squads goal progress <squad> <idx> "<update>"  # Update progress
squads goal complete <squad> <idx>  # Mark done
```

### Sessions
```bash
squads sessions               # List active sessions
squads sessions history       # Session history
squads session start          # Register session (for hooks)
squads session stop           # End session
squads session heartbeat      # Update activity
```

### Stack (Docker infrastructure)
```bash
squads stack init             # Setup wizard
squads stack status           # Container health
squads stack health           # Full diagnostics
squads stack up               # Start containers
squads stack down             # Stop containers
squads stack logs <service>   # View logs
```

**Valid services:** postgres, redis, neo4j, bridge, langfuse, mem0, engram, otel

### Triggers (smart execution)
```bash
squads trigger list           # View triggers
squads trigger sync           # Sync SQUAD.md to scheduler
squads trigger fire <name>    # Manually fire
squads trigger enable <name>  # Enable trigger
squads trigger disable <name> # Disable trigger
squads trigger status         # Scheduler stats
```

### Run Command Options
```bash
squads run engineering              # Run whole squad
squads run engineering/agent        # Slash notation for specific agent
squads run engineering -a agent     # Flag notation
squads run engineering --dry-run    # Preview only
squads run engineering --execute    # Execute via Claude CLI
squads run engineering --parallel   # Run all in parallel
squads run engineering --timeout 60 # Custom timeout (minutes)
```

### Monitoring & History
```bash
squads context                # Business context (goals, decisions, priorities)
squads context --topic "X"    # Topic-focused context
squads history                # Recent agent execution history
squads history --days 7       # Execution history (last N days)
squads health                 # Quick infrastructure check
squads workers                # Show active workers
squads progress               # Track agent task progress
squads results                # Show squad results (git + KPIs)
```

### Live Dashboards
```bash
squads live                   # Live TUI dashboard
squads top                    # Live process table
squads watch <command>        # Live refresh any command
squads watch status           # Example: watch status
```

### Environment & Config
```bash
squads env show <squad>       # Squad execution context (MCP, model, budget)
squads env list               # List all squad environments
squads cost                   # Cost summary (today, week, by squad)
squads budget <squad>         # Check budget status
squads providers              # Show available LLM CLI providers
squads version                # Show version information
```

### Scheduling & Automation
```bash
squads cron sync              # Sync schedules from agent .md files
squads cron list              # List scheduled agents
squads cron status            # Show cron status and next runs
squads cron logs [agent]      # Show execution logs
squads cron enable <agent>    # Enable schedule
squads cron disable <agent>   # Disable schedule
squads tonight run <targets>  # Start overnight execution
squads tonight status         # Check overnight status
squads autonomous start       # Start scheduler daemon
squads autonomous stop        # Stop scheduler daemon
squads autonomous status      # Check daemon status
```

### Approvals & Permissions
```bash
squads approval send <type>   # Send approval request to Slack
squads approval list          # List approvals
squads approval check <id>    # Check approval status
squads approval cancel <id>   # Cancel pending approval
squads permissions show <squad>   # Show permission context
squads permissions check <squad>  # Validate before execution
```

### Orchestration
```bash
squads orchestrate <squad>    # Run squad with lead agent orchestration
```

### Skills
```bash
squads skill list             # List available skills
squads skill upload <file>    # Upload a skill
squads skill delete <name>    # Delete a skill
```

### Slack Integration
```bash
squads slack auth             # Authenticate with Slack
squads slack status           # Check Slack connection
squads slack test             # Send test message
```

### Metrics
```bash
squads autonomy               # Show autonomy score and confidence
squads kpi list               # List KPIs defined in squads
squads kpi show <squad>       # Show KPIs for a squad
squads kpi update <squad>     # Update KPI values
```

## Development Workflow

### Building
```bash
npm install
npm run build         # Build with tsup
npm run dev           # Watch mode
npm link              # Test globally as `squads`
```

### Testing
```bash
npm test              # Run vitest
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Linting
```bash
npm run lint          # ESLint
npm run typecheck     # TypeScript check
```

## Code Patterns

### Adding a New Command

1. Create command file in `src/commands/<name>.ts`:
```typescript
import { colors, bold, RESET, gradient, writeLine } from '../lib/terminal.js';

export async function myCommand(options: { verbose?: boolean }): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}my-command${RESET}`);
  writeLine();
  // ... implementation
}
```

2. Register in `src/cli.ts`:
```typescript
import { myCommand } from './commands/my-command.js';

program
  .command('my-command')
  .description('My new command')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    await myCommand(options);
  });
```

### Terminal Output

Use the terminal library for consistent styling:
```typescript
import {
  colors,          // { purple, cyan, green, red, yellow, dim, white }
  bold,            // Bold text
  RESET,           // Reset formatting
  gradient,        // 'squads' gradient text
  box,             // Box drawing characters
  padEnd,          // Right-pad string
  truncate,        // Truncate with ellipsis
  icons,           // { success, error, warning, active, empty, progress }
  writeLine,       // Console output with prefix
} from '../lib/terminal.js';
```

### Memory Operations

```typescript
import {
  findMemoryDir,
  searchMemory,
  getSquadState,
  appendToMemory,
  listMemoryEntries
} from '../lib/memory.js';

// Search memory
const results = searchMemory(query, memoryDir);

// Get squad state
const states = getSquadState(squadName);

// Update memory
appendToMemory(squad, agent, type, content);
```

### Squad/Agent Parsing

```typescript
import {
  loadSquad,
  findSquadsDir,
  listSquads,
  addGoalToSquad,
  updateGoalInSquad
} from '../lib/squad-parser.js';

const squad = loadSquad(squadName);
// squad.name, squad.mission, squad.goals, squad.agents
```

## File Paths

- **Squad definitions:** `.agents/squads/<squad>/SQUAD.md`
- **Agent definitions:** `.agents/squads/<squad>/<agent>.md`
- **Memory files:** `.agents/memory/<squad>/<agent>/<type>.md`
  - Types: `state.md`, `learnings.md`, `feedback.md`
- **Session history:** `.agents/sessions/history.jsonl`
- **CLI config:** `~/.squadsrc` (stack environment)
- **Docker files:** `docker/` or `~/.squads/docker/`

## Environment Variables

```bash
# Stack services
SQUADS_DATABASE_URL    # PostgreSQL connection
SQUADS_BRIDGE_URL      # Bridge API (default: http://localhost:8088)
MEM0_API_URL           # Mem0 API (default: http://localhost:8000)
SCHEDULER_URL          # Trigger scheduler (default: http://localhost:8090)

# Langfuse telemetry
LANGFUSE_HOST
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY

# Other
HQ_PATH                # Override agents-squads/hq path
REDIS_URL              # Redis connection
```

## Common Issues

### Memory not found
```
No .agents/memory directory found
```
Run `squads init` to create the directory structure.

### Stack services not running
```
Scheduler not running or unreachable
```
Run `squads stack init` and `squads stack up` to start Docker services.

### Squad not found
```
Squad "X" not found
```
Check `.agents/squads/` directory exists and contains the squad folder with `SQUAD.md`.

## Git Workflow

- Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`)
- Feature branches for non-trivial changes
- Direct to main OK for small docs/fixes

## Resources

- [README.md](./README.md) - Full user documentation
- [CHANGELOG.md](./CHANGELOG.md) - Version history
- [agents-squads](https://github.com/agents-squads/agents-squads) - Parent project
