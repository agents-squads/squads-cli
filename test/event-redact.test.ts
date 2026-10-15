import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REDACT_PATTERNS, SUMMARY_MAX, knownSecrets, redactEvent, redactText, resetKnownSecrets } from '../src/lib/event-redact.js';
import { ExecEventWriter, createClaudeStreamJsonAdapter, type PersistedExecEvent } from '../src/lib/exec-events.js';

const KNOWN = 'dsk-live-7fQ2xKp9LmN4vR8tY3wZ';
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const PEM = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx9f8Zk3QpLmN7vR2tY5wZ8aB1cD4eF6gH9iJ0kL2mN4oP6qR\n-----END RSA PRIVATE KEY-----`;

let dir: string;
const saved = { secrets: process.env.SQUADS_SECRETS_DIR, gh: process.env.GH_TOKEN };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redact-'));
  const secrets = join(dir, 'secrets');
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'deepseek-api-key'), `${KNOWN}\n`);
  writeFileSync(join(secrets, 'sa-key.json'), JSON.stringify({ type: 'service_account', project_id: 'proj-not-secret-at-all', private_key_id: 'abcdef0123456789abcdef' }));
  writeFileSync(join(dir, 'outside'), 'outside-the-store-value-xyz');
  symlinkSync(join(dir, 'outside'), join(secrets, 'linked'));
  process.env.SQUADS_SECRETS_DIR = secrets;
  process.env.GH_TOKEN = 'gho_envTokenValue1234567890';
  resetKnownSecrets();
});
afterEach(() => {
  process.env.SQUADS_SECRETS_DIR = saved.secrets;
  if (saved.gh === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = saved.gh;
  resetKnownSecrets();
  rmSync(dir, { recursive: true, force: true });
});

describe('known secrets', () => {
  it('values from the secret store and credential-named env vars; links and non-credential JSON fields are not read', () => {
    const k = knownSecrets();
    expect(k).toContain(KNOWN);
    expect(k).toContain('abcdef0123456789abcdef');
    expect(k).toContain('gho_envTokenValue1234567890');
    expect(k).not.toContain('proj-not-secret-at-all');
    expect(k).not.toContain('outside-the-store-value-xyz');
  });
});

describe('redactText', () => {
  it('masks known values and every pattern kind, and says it fired', () => {
    const cases: [string, string][] = [
      [`key is ${KNOWN} ok`, '[redacted:known]'],
      [`token ${GH}`, '[redacted:github-token]'],
      [PEM, '[redacted:private-key]'],
      ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '[redacted:private-key]'], // cut before END
      ['curl -H "Authorization: Bearer abc.def-ghi_jkl"', 'Bearer [redacted:bearer]'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz', '[redacted:jwt]'],
      ['DB_PASSWORD=hunter2hunter2', 'DB_PASSWORD=[redacted:assigned]'],
      ['{"api_key": "abcd1234efgh"}', '[redacted:assigned]'],
      ['sk-0123456789abcdefXYZ', '[redacted:'],
      ['rut 12.345.678-9', '[redacted:chilean-rut]'],
    ];
    for (const [input, expected] of cases) {
      const r = redactText(input);
      expect(r.fired, input).toBe(true);
      expect(r.text, input).toContain(expected);
    }
    expect(redactText('max_tokens: 4096 and a plain sentence').fired).toBe(false);
    for (const ref of ['PGPASSWORD=$PGPASS psql', 'GH_TOKEN=$(cat ~/.squads/secrets/x) gh', 'apiKey: process.env.API_KEY', 'token=<your-token>']) {
      expect(redactText(ref).fired, ref).toBe(false); // references stay readable
    }
    expect(REDACT_PATTERNS.length).toBeGreaterThan(8);
  });

  it('redacts before cutting: a secret straddling the cut leaves no fragment', () => {
    const { event } = redactEvent({ type: 'tool_result', tool: 'Bash', ok: true, summary: `${'x'.repeat(SUMMARY_MAX - 10)}${KNOWN}` });
    expect(event.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(event.summary).not.toContain(KNOWN.slice(0, 8));
  });

  it('sensitivity: lifecycle low, text moderate, redaction high; structural fields untouched', () => {
    expect(redactEvent({ type: 'token_usage', input: 1, model: 'sk-0123456789abcdefXYZ' }).sensitivity).toBe('low');
    expect(redactEvent({ type: 'tool_call', tool: 'Bash', inputSummary: 'ls' }).sensitivity).toBe('moderate');
    expect(redactEvent({ type: 'tool_call', tool: 'Bash', inputSummary: `echo ${GH}` }).sensitivity).toBe('high');
  });
});

describe('the events file and the API flush (the check in #1275)', () => {
  it('a PEM block, a token and a known credential in a tool call and a tool result reach neither; the events are high', () => {
    const pushed: PersistedExecEvent[] = [];
    const flusher = { push: (l: PersistedExecEvent) => pushed.push(l), close: async () => {} } as never;
    const file = join(dir, 'events.jsonl');
    const w = new ExecEventWriter(file, 'run_1', { flusher });
    const adapter = createClaudeStreamJsonAdapter();
    w.ingestProviderLine(adapter, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: token ${GH}" -d key=${KNOWN} https://x` } }] },
    }));
    w.ingestProviderLine(adapter, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `ok\n${PEM}\nDEEPSEEK=${KNOWN}` }] },
    }));
    w.close();
    const text = readFileSync(file, 'utf8');
    for (const leak of [GH, KNOWN, 'MIIEowIBAAKCAQEA', KNOWN.slice(0, 12)]) {
      expect(text).not.toContain(leak);
      expect(JSON.stringify(pushed)).not.toContain(leak);
    }
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);
    expect(pushed).toEqual(lines); // the flush carries exactly the redacted line
    const call = lines.find((l) => l.event.type === 'tool_call')!;
    const result = lines.find((l) => l.event.type === 'tool_result')!;
    expect(call.sensitivity).toBe('high');
    expect(result.sensitivity).toBe('high');
    expect(result.event).toMatchObject({ chars: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('file-reading tools keep size and hash, never content; other inputs keep field names only', () => {
    const file = join(dir, 'events2.jsonl');
    const w = new ExecEventWriter(file, 'run_2');
    const adapter = createClaudeStreamJsonAdapter();
    w.ingestProviderLine(adapter, JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/.env' } },
      { type: 'tool_use', id: 'm1', name: 'mcp__erp__send_invoice', input: { customer: 'ACME SpA', amount: 1200000 } },
    ] } }));
    w.ingestProviderLine(adapter, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'SECRET_THING=plain value here' }] } }));
    w.close();
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);
    const read = lines.find((l) => l.event.type === 'tool_result')!.event as { summary: string; chars: number };
    expect(read.summary).toBe('');
    expect(read.chars).toBe('SECRET_THING=plain value here'.length);
    const mcp = lines.find((l) => l.event.type === 'tool_call' && (l.event as { tool: string }).tool.startsWith('mcp__'))!;
    expect((mcp.event as { inputSummary: string }).inputSummary).toBe('{customer, amount}');
    expect(readFileSync(file, 'utf8')).not.toContain('ACME');
  });
});
