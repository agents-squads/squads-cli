import { describe, it, expect } from 'vitest';
import { scanText, scanDiff, summarizeFindings } from '../src/lib/secret-scan.js';

describe('scanText — high-confidence credential shapes', () => {
  it('detects common key types', () => {
    const samples: Record<string, string> = {
      'anthropic-key': 'sk-ant-api03-' + 'A'.repeat(40),
      'github-token': 'ghp_' + 'a'.repeat(36),
      'aws-access-key': 'AKIA' + 'ABCDEFGHIJ123456',
      'slack-token': 'xoxb-12345678901-abcdefghij',
      'google-api-key': 'AIza' + 'b'.repeat(35),
      'stripe-key': 'sk_live_' + 'c'.repeat(24),
      'private-key': '-----BEGIN RSA PRIVATE KEY-----',
      'chilean-rut': '12.345.678-9',
    };
    for (const [ruleId, text] of Object.entries(samples)) {
      const f = scanText(text);
      expect(f.some((x) => x.ruleId === ruleId), `expected ${ruleId} in "${text}"`).toBe(true);
    }
  });

  it('catches a secret-named var assigned a realistic value', () => {
    expect(scanText('SLACK_BOT_TOKEN = "xkcd-not-a-real-but-long-value-123"').length).toBeGreaterThan(0);
  });

  it('ignores placeholders, env refs, and clean code', () => {
    expect(scanText('const API_KEY = process.env.API_KEY')).toEqual([]);
    expect(scanText('ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}')).toEqual([]);
    expect(scanText('PASSWORD: <your-password-here>')).toEqual([]);
    expect(scanText('just some normal source code, no secrets')).toEqual([]);
  });

  it('redacts — never echoes the raw secret', () => {
    const secret = 'ghp_' + 'z'.repeat(36);
    const f = scanText(secret);
    expect(f[0].redacted).not.toContain(secret);
    expect(summarizeFindings(f)).not.toContain(secret);
  });
});

describe('scanDiff — only ADDED lines', () => {
  it('flags a secret on an added line', () => {
    const diff = [
      'diff --git a/x b/x',
      '+++ b/x',
      '-old clean line',
      ' context line',
      '+const k = "ghp_' + 'a'.repeat(36) + '"',
    ].join('\n');
    expect(scanDiff(diff).length).toBe(1);
  });
  it('does NOT flag secrets on removed/context lines or the +++ header', () => {
    const diff = [
      '+++ b/secrets-ghp_' + 'a'.repeat(36),
      '-const k = "ghp_' + 'b'.repeat(36) + '"', // being REMOVED — fine
      ' const ctx = "ghp_' + 'c'.repeat(36) + '"', // context — fine
    ].join('\n');
    expect(scanDiff(diff)).toEqual([]);
  });
});

describe('scanText — forbidden denylist (names/codenames)', () => {
  it('flags a configured forbidden string, case-insensitive', () => {
    const f = scanText('Met with Acme Corp about the deal', { forbidden: ['acme corp'] });
    expect(f.some((x) => x.ruleId === 'denylist')).toBe(true);
  });
  it('empty/comment denylist entries are ignored', () => {
    expect(scanText('clean text', { forbidden: ['', '   '] })).toEqual([]);
  });
});
