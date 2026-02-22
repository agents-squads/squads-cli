# squads-cli

CLI for managing autonomous AI agent squads. Define AI teams, run them, monitor their work.

## Quick Start

```bash
squads init                    # Set up your project
squads status                  # See your squads, milestones, open PRs
squads run <squad>             # Run a squad
squads run <squad> -a <agent>  # Run a specific agent
```

## Core Concepts

### Squads
Domain-aligned teams of AI agents. Defined in `.agents/squads/<name>/SQUAD.md`.

Each SQUAD.md has frontmatter:
```yaml
---
name: engineering
mission: Build and maintain the platform
repo: your-org/your-repo        # Links to your git repo for milestones/PRs
stack: TypeScript
context:
  model:
    default: sonnet
---
```

### Agents
Individual AI workers defined as markdown files in a squad directory.
Each `.agents/squads/<squad>/<agent>.md` contains the agent's instructions, role, and behavior.

### Memory
Persistent state across sessions at `.agents/memory/<squad>/<agent>/`.
```bash
squads memory write <squad> [agent] "insight"   # Save a learning
squads memory read <squad> [agent]               # Load context
squads memory search "query"                     # Search across squads
```

### Milestones & PRs
`squads status` reads the `repo:` field from your SQUAD.md files and shows:
- Milestone progress from your git provider
- Open PRs across your repos

This works with any git hosting that supports the `gh` CLI or equivalent.

## Commands

### Monitoring
| Command | What It Shows |
|---------|--------------|
| `squads status` | Squad overview, milestones, open PRs |
| `squads status <squad>` | Squad detail: agents, context, recent executions |
| `squads dash` | Full dashboard: git activity, costs, goals |
| `squads dash --ceo` | Executive summary with priorities |

### Execution
| Command | What It Does |
|---------|-------------|
| `squads run <squad>` | Run a squad's lead agent |
| `squads run <squad> -a <agent>` | Run a specific agent |
| `squads run <squad> --parallel` | Run all agents in parallel |
| `squads run <squad> --dry-run` | Preview without executing |

### Memory
| Command | What It Does |
|---------|-------------|
| `squads memory write <squad> [agent] "text"` | Persist a learning |
| `squads memory read <squad> [agent]` | Load agent memory |
| `squads memory search "query"` | Search all memory |
| `squads memory list` | List all entries |

### Infrastructure
| Command | What It Does |
|---------|-------------|
| `squads stack init` | Set up local Docker services |
| `squads stack status` | Check container health |
| `squads stack up / down` | Start/stop services |
| `squads health` | Quick infrastructure check |

### Scheduling
| Command | What It Does |
|---------|-------------|
| `squads autonomous start` | Start scheduler daemon |
| `squads autonomous status` | Check daemon |
| `squads cron list` | List scheduled agents |
| `squads cron sync` | Sync schedules from agent definitions |

## Project Structure

After `squads init`, your project has:
```
.agents/
├── squads/
│   ├── <squad>/
│   │   ├── SQUAD.md          # Squad definition
│   │   └── <agent>.md        # Agent definitions
│   └── ...
├── memory/
│   └── <squad>/<agent>/      # Persistent state
├── sessions/
│   └── history.jsonl         # Execution log
├── config/
│   └── provider.yaml         # LLM provider settings
└── BUSINESS_BRIEF.md         # Your business context
```

## Working With Squads

### Define a new squad
Create `.agents/squads/my-squad/SQUAD.md` with frontmatter (name, mission, repo) and agent table.

### Define a new agent
Create `.agents/squads/my-squad/my-agent.md` with instructions for what the agent does.

### Connect to your repos
Set `repo: your-org/your-repo` in SQUAD.md frontmatter. This enables milestone tracking and PR visibility in `squads status`.

### Multi-provider support
Configure in `.agents/config/provider.yaml` or SQUAD.md frontmatter:
```yaml
context:
  model:
    default: sonnet      # Default for all tasks
    expensive: opus      # Heavy reasoning
    cheap: haiku         # Simple tasks
```

Supported: Claude, GPT-4, Gemini, Ollama, and custom providers.

## Development

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

### Code Patterns

**Adding a new command:**
1. Create `src/commands/<name>.ts`
2. Register in `src/cli.ts` via Commander.js

**Key libraries:**
```typescript
// Terminal output
import { colors, bold, gradient, writeLine } from '../lib/terminal.js';

// Squad/agent parsing
import { loadSquad, findSquadsDir, listSquads } from '../lib/squad-parser.js';

// Memory operations
import { searchMemory, appendToMemory, listMemoryEntries } from '../lib/memory.js';
```

### File Paths
- **Squad definitions:** `.agents/squads/<squad>/SQUAD.md`
- **Agent definitions:** `.agents/squads/<squad>/<agent>.md`
- **Memory files:** `.agents/memory/<squad>/<agent>/<type>.md`
- **Session history:** `.agents/sessions/history.jsonl`
- **CLI config:** `~/.squadsrc`

### Git Workflow
- Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`)
- Feature branches for non-trivial changes
- `npm run build` must pass before committing
