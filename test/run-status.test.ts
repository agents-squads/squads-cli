import { describe, it, expect } from 'vitest';
import {
  classifyTerminalStatus,
  dropPartialFirstLine,
  lastHarnessErrorLine,
  looksStructuredLog,
} from '../src/lib/run-status.js';

// The three shapes called out in cli#1321, plus the boundaries that keep a
// completed run completed.
const CLAUDE_API_ERROR_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  terminal_reason: 'api_error',
  result: 'API Error: Your account plan has expired',
  usage: { input_tokens: 10, output_tokens: 2 },
});

const KIMI_429_LINE =
  'error: failed to run prompt: provider.api_error: 429 exceeded your current quota, please check your plan';

const OPENCODE_STEP_FINISH_NO_STOP = [
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start' } }),
  JSON.stringify({
    type: 'step_finish', timestamp: 2, sessionID: 'ses_x',
    part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 1 }, cost: 0 },
  }),
].join('\n');

describe('classifyTerminalStatus — fixtures from cli#1321', () => {
  it('fixture 1: is_error result with an expired-plan message → failed/plan_expired', () => {
    const terminal = classifyTerminalStatus({
      provider: 'anthropic',
      structured: true,
      resultText: CLAUDE_API_ERROR_RESULT,
      resultIsError: true,
      exitCode: 0,
      knownFailed: true,
    });
    expect(terminal?.status).toBe('failed');
    expect(terminal?.cause).toBe('plan_expired');
    expect(terminal?.providerError?.type).toBe('plan_expired');
  });

  it('fixture 2: Kimi 429 line at exit 0 → failed/quota_exhausted', () => {
    const terminal = classifyTerminalStatus({
      provider: 'kimi-code',
      structured: false,
      rawTail: KIMI_429_LINE,
      exitCode: 0,
    });
    expect(terminal?.status).toBe('failed');
    expect(terminal?.cause).toBe('quota_exhausted');
    expect(terminal?.message).toContain('429');
  });

  it('fixture 3: opencode stream cut at a non-terminal step_finish → failed/interrupted', () => {
    const terminal = classifyTerminalStatus({
      provider: 'opencode',
      structured: true,
      rawTail: OPENCODE_STEP_FINISH_NO_STOP,
      missingTerminalResult: true,
      exitCode: 0,
      knownFailed: true,
    });
    expect(terminal?.status).toBe('failed');
    expect(terminal?.cause).toBe('interrupted');
  });
});

describe('classifyTerminalStatus — boundaries', () => {
  it('returns null for a clean result — completed is not reclassified', () => {
    const clean = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    expect(classifyTerminalStatus({
      provider: 'anthropic', structured: true, resultText: clean, resultIsError: false, exitCode: 0,
    })).toBeNull();
  });

  it('types a non-zero exit when no provider/harness evidence exists', () => {
    const terminal = classifyTerminalStatus({
      provider: 'deepseek', structured: false, rawTail: 'plain output, then it died\n', exitCode: 7,
    });
    expect(terminal?.status).toBe('failed');
    expect(terminal?.cause).toBe('nonzero_exit');
    expect(terminal?.message).toContain('code 7');
  });

  it('is orphaned only when a dead process left no cause', () => {
    const terminal = classifyTerminalStatus({
      provider: 'deepseek', structured: false, rawTail: 'ordinary output\n', processGone: true,
    });
    expect(terminal?.status).toBe('orphaned');
    expect(terminal?.cause).toBe('orphaned');
  });

  it('does not promote a recovered early error line in a long clean log', () => {
    const recovered = ['error: tool call failed, retrying', ...Array.from({ length: 25 }, (_, i) => `step ${i} ok`)].join('\n');
    expect(classifyTerminalStatus({
      provider: 'deepseek', structured: false, rawTail: recovered, exitCode: 0,
    })).toBeNull();
  });

  it('does not flip a clean exit-0 plain-text run whose harness error was recovered from (F2)', () => {
    // The error line is followed by real activity — an agent that recovered,
    // not a harness that died. A completed run must stay completed.
    const recovered = [
      'reading schema',
      'error: schema file not found, falling back to defaults',
      'using default schema',
      'finished 12 tasks',
      'done',
    ].join('\n');
    expect(classifyTerminalStatus({
      provider: 'aider', structured: false, rawTail: recovered, exitCode: 0,
    })).toBeNull();
  });

  it('still fails a clean-exit run whose harness error line is terminal', () => {
    const terminal = ['working', 'fatal: wrapper died before reporting'].join('\n');
    const result = classifyTerminalStatus({
      provider: 'aider', structured: false, rawTail: terminal, exitCode: 0,
    });
    expect(result?.status).toBe('failed');
    expect(result?.cause).toBe('harness_error');
  });

  it('never reads agent prose from a structured stream as an error', () => {
    const prose = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'Documented the 429 rate limit handling and the plan expiry runbook.',
    });
    expect(classifyTerminalStatus({
      provider: 'glm', structured: true, rawTail: prose, exitCode: 0,
    })).toBeNull();
  });

  it('prefers the typed provider cause over the generic non-zero exit', () => {
    const terminal = classifyTerminalStatus({
      provider: 'deepseek',
      structured: false,
      rawTail: 'litellm.AuthenticationError: {"error":{"type":"authentication_error"}} status 401\n',
      exitCode: 1,
      knownFailed: true,
    });
    expect(terminal?.cause).toBe('auth_invalid');
  });
});

describe('terminal log helpers', () => {
  it('finds an anchored harness error line near the end', () => {
    expect(lastHarnessErrorLine('ok\nmore ok\nfatal: wrapper died')).toBe('fatal: wrapper died');
    expect(lastHarnessErrorLine('{"type":"result","is_error":false}')).toBeNull();
  });

  it('recognises a structured stream from its first line', () => {
    expect(looksStructuredLog('{"type":"result"}\n')).toBe(true);
    expect(looksStructuredLog('plain provider text\n')).toBe(false);
    expect(looksStructuredLog('')).toBe(false);
  });

  it('drops the partial first line of a capped tail so structure survives (F3)', () => {
    const trimmed = dropPartialFirstLine('artial json fragment..."\n{"type":"result"}\n');
    expect(trimmed).toBe('{"type":"result"}\n');
    expect(looksStructuredLog(trimmed)).toBe(true);
    expect(dropPartialFirstLine('no newline at all')).toBe('');
  });
});
