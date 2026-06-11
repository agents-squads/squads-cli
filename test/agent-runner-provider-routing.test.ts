import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #844: provider runs must execute in the squad's bound
 * repo (SQUAD.md `repo:` → sibling dir), not whatever repo the dispatch ran
 * from. The bug shipped because agent-runner's executeWithProvider call simply
 * omitted `cwd` and the engine silently fell back to getProjectRoot() —
 * type-safe, test-green, and routing every harvest to the wrong repo.
 *
 * A full runAgent() unit test needs 8+ module mocks (cooldowns, gates,
 * context assembly, permissions) and would pin implementation details far
 * beyond this contract. The fix was validated live twice (broken: harvest on
 * hq; fixed: harvest on research). This source-contract test covers the
 * narrow regression: the provider call site must route cwd through
 * resolveTargetRepoRoot.
 */
describe('agent-runner provider routing (#844)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'agent-runner.ts'),
    'utf8'
  );

  it('passes cwd via resolveTargetRepoRoot to executeWithProvider', () => {
    const callSite = source.slice(source.indexOf('executeWithProvider(provider'));
    const optionsBlock = callSite.slice(0, callSite.indexOf('});'));
    expect(optionsBlock).toContain('cwd: resolveTargetRepoRoot(');
  });

  it('imports resolveTargetRepoRoot from the execution engine', () => {
    expect(source).toMatch(/import \{[^}]*resolveTargetRepoRoot[^}]*\} from '\.\/execution-engine\.js'/s);
  });
});
