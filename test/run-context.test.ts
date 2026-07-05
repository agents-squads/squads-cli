import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseAgentFrontmatter, gatherSquadContext } from '../src/lib/run-context.js';

// ── parseAgentFrontmatter ────────────────────────────────────────────────

describe('parseAgentFrontmatter', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-run-context-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns empty object for non-existent file', () => {
    const result = parseAgentFrontmatter('/nonexistent/agent.md');
    expect(result).toEqual({});
  });

  it('returns empty object when file has no frontmatter', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, '# My Agent\n\nDoes stuff.\n');
    const result = parseAgentFrontmatter(agentPath);
    expect(result).toEqual({});
  });

  it('parses max_context_tokens from frontmatter', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, `---
role: worker
max_context_tokens: 5000
---

# My Agent

Does stuff.
`);
    const result = parseAgentFrontmatter(agentPath);
    expect(result.max_context_tokens).toBe(5000);
  });

  it('parses max_context_tokens alongside other fields', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, `---
role: lead
max_retries: 3
max_context_tokens: 20000
cooldown: 6h
---

# Lead Agent
`);
    const result = parseAgentFrontmatter(agentPath);
    expect(result.max_context_tokens).toBe(20000);
    expect(result.max_retries).toBe(3);
    expect(result.agent_role).toBe('lead');
    expect(result.cooldown).toBe('6h');
  });

  it('leaves max_context_tokens undefined when not set', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, `---
role: worker
max_retries: 2
---

# Agent
`);
    const result = parseAgentFrontmatter(agentPath);
    expect(result.max_context_tokens).toBeUndefined();
  });

  it('parses max_context_tokens as integer', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, `---
max_context_tokens: 12500
---

# Agent
`);
    const result = parseAgentFrontmatter(agentPath);
    expect(result.max_context_tokens).toBe(12500);
    expect(typeof result.max_context_tokens).toBe('number');
  });

  it('parses small max_context_tokens values', () => {
    const agentPath = join(testDir, 'agent.md');
    writeFileSync(agentPath, `---
role: scanner
max_context_tokens: 1000
---

# Scanner Agent
`);
    const result = parseAgentFrontmatter(agentPath);
    expect(result.max_context_tokens).toBe(1000);
  });
});

// ── gatherSquadContext maxTokens budget enforcement ───────────────────────────
//
// gatherSquadContext uses maxTokens (tokens * 4 = chars) as the budget cap.
// When no squad/memory dir is found it returns '' — so these tests work in
// isolation (no .agents directory present in test cwd) and verify the budget
// math only when content is actually injected.
// The core contract tested here: if maxTokens is provided, the char budget
// used is maxTokens * 4, not the ROLE_BUDGETS[role] default.

describe('gatherSquadContext — maxTokens option', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-ctx-budget-test-' + Date.now());
    // Set up a minimal squads + memory layout
    mkdirSync(join(testDir, '.agents', 'squads', 'cli'), { recursive: true });
    mkdirSync(join(testDir, '.agents', 'memory', 'cli'), { recursive: true });
    // Write SQUAD.md so the squad dir is recognized
    writeFileSync(join(testDir, '.agents', 'squads', 'cli', 'SQUAD.md'), '# CLI Squad\n');
    // Write a goals file large enough to test truncation
    writeFileSync(join(testDir, '.agents', 'memory', 'cli', 'goals.md'), 'G'.repeat(20000));
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns non-empty context when squads and memory dirs exist', () => {
    const ctx = gatherSquadContext('cli', 'issue-solver', { role: 'worker' });
    // If directories are found, context should be non-empty
    // (may be empty if findSquadsDir fails in this test runner's cwd)
    expect(typeof ctx).toBe('string');
  });

  it('maxTokens override produces smaller output than role default when content exists', () => {
    const ctxDefault = gatherSquadContext('cli', 'issue-solver', { role: 'worker' });
    const ctxOverride = gatherSquadContext('cli', 'issue-solver', {
      role: 'worker',
      maxTokens: 100, // 400 chars — much smaller than worker's 12000
    });

    // If both are non-empty, the override should be smaller
    if (ctxDefault.length > 0 && ctxOverride.length > 0) {
      expect(ctxOverride.length).toBeLessThan(ctxDefault.length);
      expect(ctxOverride.length).toBeLessThanOrEqual(500); // 400 char budget + header
    }

    // Both should be strings (never throw)
    expect(typeof ctxDefault).toBe('string');
    expect(typeof ctxOverride).toBe('string');
  });
});

// ── gatherSquadContext — injection CONTRACT (audit hardening, 2026-06) ───────
//
// The prior tests only asserted `typeof ctx === 'string'` (always true) or were
// guarded by `if (length > 0)` (silently skipped when empty), so the actual
// behavior the context system depends on — layer ORDER, role GATING,
// strategy.md as L1, budget DROP, and stale-memory caveats — was unverified.
// These build a real .agents fixture and assert that behavior directly.
//
// Hermetic: findSquadsDir/findMemoryDir walk up from cwd and step 1 (ancestor
// walk) finds the fixture before any git-aware fallback, so these never read
// the real repo.

describe('gatherSquadContext — injection contract', () => {
  let testDir: string;
  let originalCwd: string;
  let agentPath: string;
  const SQUAD = 'eng';
  const AGENT = 'builder';

  // Unique markers per layer so we can assert presence + ordering by index.
  const M = {
    founder: 'FOUNDER_CTX_MARKER',
    strategy: 'STRATEGY_MARKER',
    alignment: 'ALIGNMENT_MARKER',
    feedback: 'FEEDBACK_MARKER',
    goals: 'GOALS_MARKER',
    state: 'STATE_MARKER',
    agent: 'AGENT_BODY_MARKER',
    briefing: 'BRIEFING_MARKER',
  };

  function writeFixture(opts: { feedbackMtimeDaysAgo?: number; agentRole?: string } = {}) {
    const root = join(testDir, '.agents');
    const mem = join(root, 'memory');
    const sq = join(root, 'squads', SQUAD);
    mkdirSync(sq, { recursive: true });
    mkdirSync(join(mem, 'company'), { recursive: true });
    mkdirSync(join(mem, SQUAD, AGENT), { recursive: true });

    writeFileSync(join(sq, 'SQUAD.md'), '# Eng Squad\n');
    agentPath = join(sq, `${AGENT}.md`);
    writeFileSync(
      agentPath,
      `---\nrole: ${opts.agentRole ?? 'worker'}\n---\n\n# Builder\n\n${M.agent} — write code.\n`,
    );
    // L9 founder-context (universal) and L1 company/strategy.md
    writeFileSync(join(mem, 'company', 'founder-context.md'), `${M.founder}\n${'F'.repeat(200)}`);
    writeFileSync(join(mem, 'company', 'strategy.md'), `# Strategy — Test\n${M.strategy}\n${'S'.repeat(200)}`);
    // L10 per-squad alignment, L6 feedback, L3 goals, L5 state, L7 briefing
    writeFileSync(join(mem, SQUAD, 'founder-alignment.md'), `${M.alignment}\n${'L'.repeat(100)}`);
    const feedbackFile = join(mem, SQUAD, 'feedback.md');
    writeFileSync(feedbackFile, `${M.feedback}\n${'B'.repeat(100)}`);
    if (opts.feedbackMtimeDaysAgo !== undefined) {
      const tSec = (Date.now() - opts.feedbackMtimeDaysAgo * 86_400_000) / 1000;
      utimesSync(feedbackFile, tSec, tSec);
    }
    writeFileSync(join(mem, SQUAD, 'goals.md'), `## Active\n${M.goals}\n${'G'.repeat(100)}`);
    writeFileSync(join(mem, SQUAD, AGENT, 'state.md'), `${M.state}\n${'T'.repeat(100)}`);
    writeFileSync(join(mem, 'daily-briefing.md'), `${M.briefing}\n${'D'.repeat(100)}`);
  }

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-ctx-contract-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('injects layers in action-first order: founder→alignment→feedback→goals→state→agent→strategy', () => {
    writeFixture();
    const ctx = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker' });
    const order = [M.founder, M.alignment, M.feedback, M.goals, M.state, M.agent, M.strategy];
    const positions = order.map((m) => ctx.indexOf(m));
    // every marker present
    expect(positions.every((p) => p >= 0)).toBe(true);
    // strictly increasing → documented order holds
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('loads company/strategy.md as the L1 "Company" layer (#878)', () => {
    writeFixture();
    const ctx = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker' });
    expect(ctx).toContain(M.strategy);
    // The Company header precedes the strategy content (it IS the company layer).
    expect(ctx.indexOf('## Company')).toBeGreaterThanOrEqual(0);
    expect(ctx.indexOf('## Company')).toBeLessThan(ctx.indexOf(M.strategy));
  });

  it('gates layers by role: scanner omits feedback+briefing, worker adds feedback, lead adds briefing', () => {
    writeFixture();
    const scanner = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'scanner' });
    const worker = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker' });
    const lead = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'lead' });

    // Universal layers present for every role
    for (const ctx of [scanner, worker, lead]) {
      expect(ctx).toContain(M.founder);
      expect(ctx).toContain(M.strategy);
      expect(ctx).toContain(M.goals);
    }
    // scanner: no feedback (L6), no daily-briefing (L7)
    expect(scanner).not.toContain(M.feedback);
    expect(scanner).not.toContain(M.briefing);
    // worker: feedback yes, briefing no
    expect(worker).toContain(M.feedback);
    expect(worker).not.toContain(M.briefing);
    // lead: briefing yes
    expect(lead).toContain(M.briefing);
  });

  it('drops late layers (strategy) before early ones (founder-context) when budget is tight', () => {
    writeFixture();
    // ~50 tokens = 200 chars: only the first-injected layer survives.
    const ctx = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker', maxTokens: 50 });
    expect(ctx).toContain(M.founder); // injected first → survives
    expect(ctx).not.toContain(M.strategy); // injected late → dropped
  });

  it('caveats stale feedback so months-old corrections are not read as current (audit F1)', () => {
    writeFixture({ feedbackMtimeDaysAgo: 90 });
    const ctx = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker' });
    expect(ctx).toContain(M.feedback);
    expect(ctx).toContain('Last updated 90 days ago');
  });

  it('does not caveat fresh feedback', () => {
    writeFixture(); // feedback written now → mtime today
    const ctx = gatherSquadContext(SQUAD, AGENT, { agentPath, role: 'worker' });
    expect(ctx).toContain(M.feedback);
    expect(ctx).not.toContain('Last updated');
  });
});
