# squads-cli

CLI orchestrator for autonomous AI agent squads. Agents are defined as markdown files, organized into squads, and executed via native AI CLIs (claude, gemini, etc.).

## Build & Test

```bash
npm install
npm run build         # tsup → dist/
npm test              # vitest (1700+ tests)
npm run lint          # eslint
npm link              # test globally as `squads`
```

`npm run build` must pass before committing. Conventional Commits format.

## Architecture

```
src/
├── cli.ts                 # Command registration (Commander.js)
├── commands/              # One file per command (lazy-imported)
│   ├── run.ts             # Core: agent execution + autopilot
│   ├── init.ts            # Project bootstrapping
│   ├── create.ts          # Squad creation (exposed as `squads add`)
│   ├── status.ts          # Squad/org overview
│   ├── dashboard.ts       # Full dashboard
│   └── ...
├── lib/
│   ├── squad-parser.ts    # Filesystem-based squad/agent discovery
│   ├── run-context.ts     # Context cascade assembly
│   ├── conversation.ts    # Multi-agent conversation protocol
│   ├── workflow.ts        # Conversation orchestration loop
│   ├── llm-clis.ts        # Provider CLI integration (claude, gemini, etc.)
│   ├── providers.ts       # Provider registry + pricing
│   ├── memory.ts          # Persistent agent memory (filesystem)
│   ├── terminal.ts        # Colors, formatting, output helpers
│   ├── git.ts             # Git operations
│   ├── github.ts          # GitHub API via gh CLI
│   ├── telemetry.ts       # Anonymous usage tracking
│   └── ...
├── version.ts             # Package version
templates/                 # `squads init` scaffolding templates
test/                      # Vitest unit + e2e tests
```

## Key Patterns

**Command registration** — `cli.ts` uses lazy dynamic imports. Commands are only loaded when invoked:
```typescript
.action(async (name, options) => {
  const { createCommand } = await import('./commands/create.js');
  return createCommand(name, options);
});
```

**Removed commands** — use `removedCommand()` helper to show migration message:
```typescript
program.command('old', { hidden: true }).description('[removed]')
  .action(removedCommand('old', 'Use: squads new-command'));
```

**Squad/agent discovery** — filesystem-based via `squad-parser.ts`:
```typescript
import { findSquadsDir, listSquads, listAgents, loadSquad } from '../lib/squad-parser.js';
```

**Terminal output** — never use raw `console.log` in commands. Use:
```typescript
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';
```

**Every command supports `--json`** for machine consumption.

## Rules

- TypeScript strict mode. No `any`.
- No new dependencies without approval.
- No hardcoded repos, orgs, or paths — use `findProjectRoot()`, `loadSquad()`, `listSquads()`.
- Graceful degradation — show local data when API unavailable, never crash on missing optional data.
- Feature branches for non-trivial changes. PRs to `develop`.
