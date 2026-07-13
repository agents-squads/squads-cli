import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #1093: `--force` means "re-run squads that already
 * completed today" (run-types.ts) — it must never be forwarded into
 * refreshFounderContext, where force triggers a synchronous full digest
 * regeneration. Conflating the two rebuilt founder-context.md on EVERY forced
 * dispatch, so two dispatches seconds apart each read a different digest
 * (compounding haiku drift, including fabricated squad names read by agents
 * as blocking policy). Explicit sync regen remains available via
 * SQUADS_DIGEST_SYNC=1 or the digest script's --full flag.
 *
 * A behavioral runCommand() test needs a deep mock stack (telemetry, gates,
 * squad loading); this source contract pins the narrow regression the same
 * way agent-runner-provider-routing.test.ts does for #844.
 */
describe('founder-context refresh call sites (#1093)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'run.ts'),
    'utf8'
  );

  it('never passes a force option into refreshFounderContext', () => {
    const calls = source.match(/refresh(?:FounderContext|Ctx)\s*\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/force/);
    }
  });
});
