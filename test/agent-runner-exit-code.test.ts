import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #957: a missing provider CLI must produce a truthful
 * nonzero exit code, not just a yellow warning that a caller (CI, install
 * scripts, other agents) has no way to detect. runAgent() has 8+ module
 * dependencies (cooldowns, gates, context assembly, permissions — see the
 * #844 routing test in agent-runner-provider-routing.test.ts for the same
 * tradeoff), so this is a source-contract test on the single-agent
 * `!cliAvailable` branch rather than a full behavioral mock.
 */
describe('agent-runner exit code on missing CLI (#957)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'agent-runner.ts'),
    'utf8'
  );

  it('sets process.exitCode = 1 inside the !cliAvailable branch', () => {
    const branchStart = source.indexOf('if (!cliAvailable) {');
    expect(branchStart).toBeGreaterThan(-1);

    const nextLine = source.indexOf("writeLine(`  ${colors.dim}To launch as background task", branchStart);
    expect(nextLine).toBeGreaterThan(branchStart);

    const block = source.slice(branchStart, nextLine);
    expect(block).toContain('process.exitCode = 1');
  });
});
