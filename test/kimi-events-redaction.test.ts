import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeDetachedLog, execEventsFile } from '../src/lib/exec-events.js';

// #1275 × #1309: kimi-code lanes normalize through the same ExecEventWriter, so
// redaction at write time must cover them too.
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

describe('kimi-code events are redacted at write time', () => {
  it('a secret in a kimi tool result never reaches the events file', () => {
    const obs = mkdtempSync(join(tmpdir(), 'kimi-redact-'));
    try {
      const log = [
        JSON.stringify({ role: 'meta', type: 'system.version', version: '2.2.0' }),
        JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', id: 't1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'cat .env' }) } }] }),
        JSON.stringify({ role: 'tool', tool_call_id: 't1', content: `GITHUB_TOKEN=${GH}` }),
        JSON.stringify({ role: 'assistant', content: `token is ${GH}` }),
      ].join('\n');
      normalizeDetachedLog(log, obs, 'exec_kimi_redact', 'tester', undefined, 'kimi-code', 'kimi-code');
      const written = readFileSync(execEventsFile(obs, 'exec_kimi_redact'), 'utf-8');
      expect(written.length).toBeGreaterThan(0);
      expect(written).not.toContain(GH);
      expect(written).toContain('[redacted:github-token]');
      expect(written).toContain('"sensitivity":"high"');
    } finally {
      rmSync(obs, { recursive: true, force: true });
    }
  });
});
