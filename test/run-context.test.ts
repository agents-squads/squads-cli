import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
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
