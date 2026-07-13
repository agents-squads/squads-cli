import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #1101: the background/detached branch of
 * executeWithProvider rebuilt the provider argv with a SECOND
 * `cliConfig.buildArgs(escapedPrompt)` call that omitted buildOpts — so
 * claude-harness lanes (glm) spawned with no --allowedTools and every
 * Write/Edit was denied in --print mode (the lane went read-only and died
 * dumping its implementation as text). Type-safe, test-green, broken at the
 * call site — same class as #844, same source-contract guard: both spawn
 * paths must share ONE argv construction.
 */
describe('executeWithProvider background argv (#1101)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'execution-engine.ts'),
    'utf8'
  );
  const fn = source.slice(
    source.indexOf('export async function executeWithProvider('),
  );

  it('builds the provider argv exactly once (buildOpts included)', () => {
    const calls = fn.match(/cliConfig\.buildArgs\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(fn).toMatch(/cliConfig\.buildArgs\(\s*effectivePrompt\s*,\s*buildOpts\s*\)/);
  });

  it('derives the detached shell argv from the shared args array, shell-escaping each arg', () => {
    expect(fn).toMatch(/const providerArgs = args\s*\.map\(\s*a\s*=>.*\.replace\(.*\)\s*.*\.join\(' '\)/);
  });
});
