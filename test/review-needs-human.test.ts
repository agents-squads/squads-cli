import { describe, it, expect } from 'vitest';
import { needsHuman } from '../src/commands/review.js';

describe('needsHuman (generic blocker classification)', () => {
  it.each([
    'needs:human to approve the budget',
    'needs-human: sign contract',
    'Needs founder decision',
    'assigned to founder',
    'Enable at console settings',
    'run auth login first',
    'Waiting on the owner',
  ])('flags "%s"', (t) => expect(needsHuman(t)).toBe(true));

  it.each([
    'Flaky test in CI',
    'Dependency bump pending review',
    'bank cartola export missing',
  ])('does not flag agent-resolvable "%s"', (t) => expect(needsHuman(t)).toBe(false));

  it('has no hardcoded personal login', () => {
    expect(needsHuman('mentioned by kokevidaurre')).toBe(false);
  });
});
