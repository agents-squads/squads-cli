
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
