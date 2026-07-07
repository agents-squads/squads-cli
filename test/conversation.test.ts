
// ─── #990: structured handoff parsing ───────────────────────────────────
import { parseHandoff } from '../src/lib/conversation.js';

describe('parseHandoff (#990)', () => {
  it('flags DONE contradicted by a non-empty undone list', () => {
    const h = parseHandoff(`work summary\n## HANDOFF\ncompleted: the feature\nundone: tests for edge cases\ncommands: \`npm run build\` → 0\nissues: none\nprocedures: followed\n## STATUS: DONE`);
    expect(h.present).toBe(true);
    expect(h.contradictsDone).toBe(true);
  });

  it('flags DONE contradicted by a failing exit code', () => {
    const h = parseHandoff(`## HANDOFF\ncompleted: impl\nundone: none\ncommands: \`npm test\` → 1, \`npm run build\` -> 0\nissues: none\nprocedures: followed\n## STATUS: DONE`);
    expect(h.exitCodes).toEqual([1, 0]);
    expect(h.contradictsDone).toBe(true);
  });

  it('clean DONE handoff does not contradict', () => {
    const h = parseHandoff(`## HANDOFF\ncompleted: all\nundone: none\ncommands: \`npm test\` → 0\nissues: none\nprocedures: followed\n## STATUS: DONE`);
    expect(h.contradictsDone).toBe(false);
  });

  it('BLOCKED with undone items is honest, not a contradiction', () => {
    const h = parseHandoff(`## HANDOFF\ncompleted: partial\nundone: the API half\ncommands: \`npm test\` → 1\nissues: quota\nprocedures: followed\n## STATUS: BLOCKED quota wall`);
    expect(h.contradictsDone).toBe(false);
  });

  it('absent handoff parses as not-present, never throws', () => {
    const h = parseHandoff('did stuff\n## STATUS: DONE');
    expect(h.present).toBe(false);
    expect(h.contradictsDone).toBe(false);
  });
});

// ─── #989: validation contract extraction ────────────────────────────────
import { extractValidationContract } from '../src/lib/conversation.js';

describe('extractValidationContract (#989)', () => {
  it('extracts the contract block from plan output', () => {
    const plan = `Thinking...\n## VALIDATION CONTRACT\n1. \`squads run demo\` exits 0 and prints the greeting\n2. npm test passes\n\n\`\`\`plan\nGOAL: x\nTASKS:\n- worker: a | task: b | satisfies: 1,2\n\`\`\`\n## STATUS: CONTINUE`;
    const c = extractValidationContract(plan);
    expect(c).toContain('exits 0');
    expect(c).toContain('2. npm test passes');
    expect(c).not.toContain('GOAL:');
  });

  it('returns empty string when no contract present (older plans stay valid)', () => {
    expect(extractValidationContract('## STATUS: CONTINUE')).toBe('');
  });

  it('stops at the next heading', () => {
    const c = extractValidationContract('## VALIDATION CONTRACT\n1. one\n## STATUS: CONTINUE');
    expect(c).toBe('1. one');
  });
});
