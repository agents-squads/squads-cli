/** cli#1045: the memory writer must refuse corrupt path segments instead of
 * mkdir'ing garbage trees. One test per observed corruption class. */
import { describe, it, expect } from 'vitest';
import { assertValidMemorySegment } from '../src/lib/memory.js';

describe('assertValidMemorySegment', () => {
  it('accepts normal squad/agent/type names', () => {
    for (const s of ['cli', 'issue-solver', 'design-system', 'state', 'learnings', 'a_b.c-d'.replace('.c', 'c')]) {
      expect(assertValidMemorySegment(s, 'squad')).toBe(s);
    }
  });

  it('rejects falsy stringifications (the zero/null dirs)', () => {
    for (const s of ['0', 'null', 'undefined', 'None', 'NaN', '', '   ']) {
      expect(() => assertValidMemorySegment(s, 'squad')).toThrow(/1045/);
    }
    expect(() => assertValidMemorySegment(0 as unknown, 'squad')).toThrow(/1045/);
    expect(() => assertValidMemorySegment(null as unknown, 'agent')).toThrow(/1045/);
    expect(() => assertValidMemorySegment(undefined as unknown, 'agent')).toThrow(/1045/);
  });

  it('rejects absolute-path / separator fragments (nested-home-dir class)', () => {
    expect(() => assertValidMemorySegment('/Users/x/.agents/memory/cli', 'agent')).toThrow(/separator/);
    expect(() => assertValidMemorySegment('a/b', 'squad')).toThrow(/separator/);
    expect(() => assertValidMemorySegment('..', 'squad')).toThrow(/1045/);
  });

  it('rejects file-name-shaped segments (.md-as-directory class)', () => {
    expect(() => assertValidMemorySegment('executions.md', 'agent')).toThrow(/file name/);
    expect(() => assertValidMemorySegment('agent.json', 'agent')).toThrow(/file name/);
  });
});
