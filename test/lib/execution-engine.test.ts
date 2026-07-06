/**
 * Tests for src/lib/execution-engine.ts — preflightExecutorCheck auth gate (#956).
 *
 * preflightExecutorCheck caches its auth probe for the process lifetime (a
 * multi-agent run must probe once, not once per spawned agent), so each test
 * resets the module registry and re-imports fresh to get an isolated cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '', bold: '' },
  RESET: '',
  icons: { success: '✓', error: '✗', warning: '!', progress: '›', empty: '○', bullet: '•' },
}));

vi.mock('../../src/lib/llm-clis.js', () => ({
  getCLIConfig: vi.fn(() => undefined),
  isProviderCLIAvailable: vi.fn(() => true),
}));

// Fake the auth probe/runner (#956) instead of spawning a real `claude` process.
vi.mock('../../src/lib/run-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/run-utils.js')>();
  return {
    ...actual,
    checkClaudeCliAvailable: vi.fn(() => Promise.resolve(true)),
    checkClaudeAuthenticated: vi.fn(),
  };
});

describe('preflightExecutorCheck — auth gate (#956)', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalSkip = process.env.SQUADS_SKIP_CHECKS;

  beforeEach(() => {
    vi.resetModules();
    // Mock instances persist across resetModules — clear their call counts or
    // assertions like `not.toHaveBeenCalled()` see earlier tests' calls.
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SQUADS_SKIP_CHECKS;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalSkip === undefined) delete process.env.SQUADS_SKIP_CHECKS;
    else process.env.SQUADS_SKIP_CHECKS = originalSkip;
  });

  it('blocks before any agent spawn when the probe reports not logged in, and probes only once (cached for the process)', async () => {
    const { preflightExecutorCheck } = await import('../../src/lib/execution-engine.js');
    const { checkClaudeAuthenticated } = await import('../../src/lib/run-utils.js');
    const { writeLine } = await import('../../src/lib/terminal.js');
    vi.mocked(checkClaudeAuthenticated).mockReturnValue(false);

    const first = await preflightExecutorCheck('anthropic');
    const second = await preflightExecutorCheck('anthropic');

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(checkClaudeAuthenticated).toHaveBeenCalledTimes(1);

    const calls = vi.mocked(writeLine).mock.calls.map((c) => c[0]?.toString() ?? '');
    expect(calls.some((msg) => msg.includes('not logged in') && msg.includes('claude /login'))).toBe(true);
  });

  it('passes when the probe reports authenticated', async () => {
    const { preflightExecutorCheck } = await import('../../src/lib/execution-engine.js');
    const { checkClaudeAuthenticated } = await import('../../src/lib/run-utils.js');
    vi.mocked(checkClaudeAuthenticated).mockReturnValue(true);

    expect(await preflightExecutorCheck('anthropic')).toBe(true);
  });

  it('skips the probe entirely when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { preflightExecutorCheck } = await import('../../src/lib/execution-engine.js');
    const { checkClaudeAuthenticated } = await import('../../src/lib/run-utils.js');

    expect(await preflightExecutorCheck('anthropic')).toBe(true);
    expect(checkClaudeAuthenticated).not.toHaveBeenCalled();
  });

  it('does not probe auth for non-anthropic providers', async () => {
    const { preflightExecutorCheck } = await import('../../src/lib/execution-engine.js');
    const { checkClaudeAuthenticated } = await import('../../src/lib/run-utils.js');

    expect(await preflightExecutorCheck('google')).toBe(true);
    expect(checkClaudeAuthenticated).not.toHaveBeenCalled();
  });

  it('skips every check, including auth, when SQUADS_SKIP_CHECKS=1', async () => {
    process.env.SQUADS_SKIP_CHECKS = '1';
    const { preflightExecutorCheck } = await import('../../src/lib/execution-engine.js');
    const { checkClaudeAuthenticated } = await import('../../src/lib/run-utils.js');

    expect(await preflightExecutorCheck('anthropic')).toBe(true);
    expect(checkClaudeAuthenticated).not.toHaveBeenCalled();
  });
});
