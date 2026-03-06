# E2E Tests

End-to-end tests that verify the CLI works correctly from a user's perspective.

## What's Tested

### cli-commands.e2e.test.ts
Tests core CLI functionality:
- Version output
- Help system
- Command listing
- Provider enumeration
- Error handling for unknown commands

### workflows.e2e.test.ts
Tests critical user workflows:
- `squads init` — creates project structure, squad directories, SQUAD.md files, memory dir
- `squads status` — reads and displays squad state after init
- `squads run --dry-run` — validates run command without executing agents

## Running E2E Tests

```bash
# Run all tests (including E2E)
npm test

# Run only E2E tests
npm test -- test/e2e/

# Run specific E2E test file
npm test -- test/e2e/workflows.e2e.test.ts
```

## Adding New E2E Tests

When adding new E2E tests:
1. Use the `CLI_PATH` constant to reference the built CLI
2. Test from a user's perspective (what they see/experience)
3. Use temp directories for file system operations
4. Clean up resources in `afterEach` hooks
5. Test both success and failure paths

Example:
```typescript
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js');

it('tests something', () => {
  const output = execSync(`node ${CLI_PATH} command`, {
    encoding: 'utf-8',
  });

  expect(output).toContain('expected output');
});
```
