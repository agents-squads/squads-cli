/**
 * Tests for src/lib/claude-sessions.ts — the reader that rolls up ALL Claude
 * Code sessions (interactive + squad) from ~/.claude/projects, attributes them,
 * and prices tokens into a notional cost.
 *
 * Uses a real tmp fixture tree (encoded project dirs + small .jsonl files) so
 * the streaming read, attribution, and window filter are exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSessionLine,
  attributeProjectDir,
  readClaudeSessions,
  totalTokens,
} from '../src/lib/claude-sessions.js';

describe('parseSessionLine', () => {
  it('extracts tokens + model + timestamp from an assistant line', () => {
    const out = parseSessionLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-07T13:25:23.624Z',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 8417, output_tokens: 1766, cache_read_input_tokens: 16202, cache_creation_input_tokens: 18987 },
        },
      })
    );
    expect(out).not.toBeNull();
    expect(out!.tokens.input_tokens).toBe(8417);
    expect(out!.tokens.output_tokens).toBe(1766);
    expect(out!.tokens.cache_read_tokens).toBe(16202);
    expect(out!.tokens.cache_write_tokens).toBe(18987);
    expect(out!.model).toBe('claude-opus-4-8');
    expect(out!.tsMs).toBe(new Date('2026-06-07T13:25:23.624Z').getTime());
  });

  it('returns null for non-assistant lines and lines without usage', () => {
    expect(parseSessionLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull();
    expect(parseSessionLine(JSON.stringify({ type: 'assistant', message: { model: 'x', usage: {} } }))).toBeNull();
    expect(parseSessionLine('')).toBeNull();
    expect(parseSessionLine('not json')).toBeNull();
  });
});

describe('attributeProjectDir', () => {
  it('classifies squad-run / worktree dirs as squad', () => {
    expect(attributeProjectDir('-Users-jorgevidaurre-agents-squads--worktrees-squads-run-cli-mq5mc3ub-0')).toBe('squad');
    expect(attributeProjectDir('-Users-jorgevidaurre-agents-squads--worktrees-intelligence-intel-verifier-1778681988545')).toBe('squad');
  });

  it('classifies repo-root dirs as interactive', () => {
    expect(attributeProjectDir('-Users-jorgevidaurre-agents-squads-hq')).toBe('interactive');
    expect(attributeProjectDir('-Users-jorgevidaurre-agents-squads-squads-cli')).toBe('interactive');
    expect(attributeProjectDir('-Users-jorgevidaurre-agents-squads')).toBe('interactive');
  });
});

describe('readClaudeSessions (fixture tree)', () => {
  const ROOT = join(tmpdir(), `squads-claude-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const PROJECTS = join(ROOT, '.claude', 'projects');
  let savedHome: string | undefined;

  // assistant line with a given timestamp + opus usage
  function aline(tsMs: number, over: Record<string, number> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: new Date(tsMs).toISOString(),
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over },
      },
    });
  }

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = ROOT;

    const now = Date.now();
    const hr = 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const midnightMs = startOfToday.getTime();
    // Anchor every timestamp to be BOTH recent (≤4h ago) AND today (≥ midnight),
    // so a 24h window and `today` both capture every fixture line deterministically
    // (no wall-clock / midnight flakiness). `ago(h)` clamps to just after midnight.
    const ago = (h: number) => Math.max(now - h * hr, midnightMs + 60 * 1000);

    // Interactive session (repo root) — two assistant lines.
    const interactiveDir = join(PROJECTS, '-Users-jorgevidaurre-agents-squads-hq');
    mkdirSync(interactiveDir, { recursive: true });
    writeFileSync(
      join(interactiveDir, 'session-a.jsonl'),
      [
        JSON.stringify({ type: 'system', subtype: 'init' }), // ignored (no usage)
        JSON.stringify({ type: 'user', message: { content: 'hi' } }), // ignored
        aline(ago(1)),
        aline(ago(3), { output_tokens: 100 }),
      ].join('\n') + '\n'
    );

    // Squad session (worktree) — one assistant line.
    const squadDir = join(PROJECTS, '-Users-jorgevidaurre-agents-squads--worktrees-squads-run-cli-abc-0');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(
      join(squadDir, 'session-b.jsonl'),
      aline(ago(2), { input_tokens: 2000, output_tokens: 1000 }) + '\n'
    );
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('attributes interactive vs squad and sums tokens per bucket (window)', async () => {
    const s = await readClaudeSessions(24, { scope: 'all' });
    expect(s.available).toBe(true);
    expect(s.filesScanned).toBe(2);

    // interactive = 2 assistant lines: (1000+500) + (1000+100); system/user ignored.
    expect(s.window.interactive.messages).toBe(2);
    expect(s.window.interactive.input_tokens).toBe(2000);
    expect(s.window.interactive.output_tokens).toBe(600);
    // squad = 1 line (2000 in, 1000 out)
    expect(s.window.squad.messages).toBe(1);
    expect(s.window.squad.input_tokens).toBe(2000);
    expect(s.window.squad.output_tokens).toBe(1000);

    // total = interactive + squad
    expect(s.window.total.input_tokens).toBe(4000);
    expect(s.window.total.output_tokens).toBe(1600);
    expect(totalTokens(s.window.total)).toBe(
      totalTokens(s.window.interactive) + totalTokens(s.window.squad)
    );
    // today captures the same set (all lines are today-anchored).
    expect(s.today.interactive.messages).toBe(2);
    expect(s.today.squad.messages).toBe(1);
  });

  it('derives a non-zero notional cost (opus pricing) and splits it', async () => {
    const s = await readClaudeSessions(24, { scope: 'all' });
    expect(s.window.interactive.cost_usd).toBeGreaterThan(0);
    expect(s.window.squad.cost_usd).toBeGreaterThan(0);
    expect(s.window.total.cost_usd).toBeCloseTo(
      s.window.interactive.cost_usd + s.window.squad.cost_usd,
      6
    );
    // opus pricing: interactive = 2000 in @ $15/M + 600 out @ $75/M = 0.03 + 0.045
    expect(s.window.interactive.cost_usd).toBeCloseTo(0.03 + 0.045, 6);
    // squad = 2000 in @ $15/M + 1000 out @ $75/M = 0.03 + 0.075
    expect(s.window.squad.cost_usd).toBeCloseTo(0.03 + 0.075, 6);
  });

  it('returns available:false (zeroed) when ~/.claude/projects is missing', async () => {
    process.env.HOME = join(ROOT, 'nonexistent-home');
    const s = await readClaudeSessions(5, { scope: 'all' });
    expect(s.available).toBe(false);
    expect(s.filesScanned).toBe(0);
    expect(totalTokens(s.window.total)).toBe(0);
  });
});

// ─── #960: project-scoped session reads ──────────────────────────────────
import { encodeProjectDir } from '../src/lib/claude-sessions.js';

describe('encodeProjectDir (#960)', () => {
  it('encodes cwd the way Claude Code names session dirs', () => {
    expect(encodeProjectDir('/Users/dev/my-app')).toBe('-Users-dev-my-app');
    expect(encodeProjectDir('/a/b.c/d')).toBe('-a-b-c-d');
  });
});

// ─── #1119: Claude-harness board rows ─────────────────────────────────────
import { attributeSquadAgent, deriveClaudeHarnessRows } from '../src/lib/claude-sessions.js';

vi.mock('../src/lib/squad-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/squad-parser.js')>();
  return { ...actual, findSquadsDir: vi.fn(() => '/fake/.agents/squads'), listSquads: vi.fn(() => ['cli', 'design-system']) };
});

describe('attributeSquadAgent (#1119)', () => {
  it('splits <squad>-<agent>-<tsMs> worktree dirs (createAgentWorktree convention)', () => {
    const dir = '-Users-x-agents-squads--worktrees-cli-issue-solver-1783982605694';
    expect(attributeSquadAgent(dir, ['cli', 'hq'])).toEqual({ squad: 'cli', agent: 'issue-solver' });
  });

  it('matches the longest known squad name so dash-containing squads split correctly', () => {
    const dir = '-Users-x-agents-squads--worktrees-design-system-tokens-1783982605694';
    expect(attributeSquadAgent(dir, ['design', 'design-system'])).toEqual({ squad: 'design-system', agent: 'tokens' });
  });

  it('reports a raw shortId (not a fabricated agent) for squads-run/-proposal multi-agent worktrees', () => {
    const dir = '-Users-x-agents-squads--worktrees-squads-run-cli-mq5mc3ub-0';
    expect(attributeSquadAgent(dir, ['cli'])).toEqual({ squad: 'cli', agent: 'mq5mc3ub-0' });
  });

  it('falls back to the raw slug when no known squad matches', () => {
    const dir = '-Users-x-agents-squads--worktrees-mystery-thing-1783982605694';
    expect(attributeSquadAgent(dir, ['cli'])).toEqual({ squad: 'mystery', agent: 'thing' });
  });

  it('attributes repo-root (non-worktree) dirs as interactive', () => {
    expect(attributeSquadAgent('-Users-jorgevidaurre-agents-squads-hq', ['cli'])).toEqual({ squad: 'interactive', agent: 'hq' });
  });
});

describe('deriveClaudeHarnessRows (fixture tree, #1119)', () => {
  const ROOT = join(tmpdir(), `squads-claude-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const PROJECTS = join(ROOT, '.claude', 'projects');
  let savedHome: string | undefined;

  const hr = 60 * 60 * 1000;
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const DAY_START = startOfToday.getTime();
  const DAY_END = DAY_START + 24 * hr;
  // Same anchoring trick as the readClaudeSessions fixtures above: keep every
  // "in bounds" timestamp both recent and after local midnight so it can
  // never straddle the day boundary depending on wall-clock time.
  const ago = (h: number) => Math.max(now - h * hr, DAY_START + 60_000);

  function aline(tsMs: number, model: string, over: Record<string, number> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: new Date(tsMs).toISOString(),
      message: { model, usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over } },
    });
  }

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = ROOT;

    const interactiveDir = join(PROJECTS, '-Users-jorgevidaurre-agents-squads-hq');
    mkdirSync(interactiveDir, { recursive: true });
    writeFileSync(
      join(interactiveDir, 'session-a.jsonl'),
      [
        aline(ago(3), 'claude-sonnet-4-6'),
        aline(ago(1), 'claude-opus-4-8', { output_tokens: 100 }),
        // Outside the day (tomorrow) — must not be summed or shift `ts`/`duration_ms`.
        aline(DAY_END + hr, 'claude-sonnet-4-6', { input_tokens: 999_999 }),
      ].join('\n') + '\n'
    );

    // Every line in this file falls before the day starts — must not produce a row.
    const otherDir = join(PROJECTS, '-Users-jorgevidaurre-agents-squads-other');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'session-b.jsonl'), aline(DAY_START - hr, 'claude-opus-4-8') + '\n');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('derives one row per session, summing only in-bounds lines', async () => {
    const rows = await deriveClaudeHarnessRows({ start: DAY_START, end: DAY_END }, { scope: 'all' });
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.id).toBe('claude:session-a');
    // Same session UUID a squads-cli ledger row would carry (#1129) — the
    // board merge dedups on this field.
    expect(row.session_id).toBe('session-a');
    expect(row.squad).toBe('interactive');
    expect(row.agent).toBe('hq');
    expect(row.provider).toBe('claude-code');
    expect(row.source).toBe('claude-code');
    expect(row.cost_estimated).toBe(true);
    expect(row.status).toBe('completed');
    expect(row.trigger).toBe('manual');
    // Only the two in-bounds lines summed — the future line's 999,999 is excluded.
    expect(row.input_tokens).toBe(2000);
    expect(row.output_tokens).toBe(600);
    expect(row.ts).toBe(new Date(ago(3)).toISOString());
    expect(row.duration_ms).toBe(ago(1) - ago(3));
    // Model from the last in-bounds line, not the excluded future one.
    expect(row.model).toBe('claude-opus-4-8');
    expect(row.cost_usd).toBeGreaterThan(0);
  });

  it('produces no row for a session with zero in-bounds lines', async () => {
    const rows = await deriveClaudeHarnessRows({ start: DAY_START, end: DAY_END }, { scope: 'all' });
    expect(rows.find((r) => r.id === 'claude:session-b')).toBeUndefined();
  });

  it('returns [] when ~/.claude/projects is missing', async () => {
    process.env.HOME = join(ROOT, 'nonexistent-home');
    const rows = await deriveClaudeHarnessRows({ start: DAY_START, end: DAY_END }, { scope: 'all' });
    expect(rows).toEqual([]);
  });
});
