/**
 * Secret / PII scanner — blocks agent commits that would leak credentials or
 * personal data (P1 of chief-cli-runtime, hq#418).
 *
 * Design choice (founder, 2026-05-29): we do NOT lock agents to a tight tool
 * allowlist — that blocks legitimate work and gives false security. Instead we
 * keep capability broad and catch the *specific* dangerous outcomes with hooks.
 * The most consequential leak is an agent auto-committing a secret/PII to a
 * (possibly public) repo, so this scanner gates `autoCommitAgentWork` before the
 * commit lands, and backs the Bash guardrail hook.
 *
 * Scope: ONLY scans *added* lines of a staged diff, and only high-confidence
 * patterns (real key shapes + private keys + Chilean RUT), so false positives
 * stay low. Names/codenames are caught via an optional, gitignored denylist
 * file (`.agents/config/forbidden-strings.txt`) the operator controls.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SecretFinding {
  type: string;
  ruleId: string;
  /** Redacted sample so we never echo the secret into logs. */
  redacted: string;
}

interface Rule {
  id: string;
  type: string;
  re: RegExp;
}

// High-confidence credential shapes (low false-positive).
const RULES: Rule[] = [
  { id: 'anthropic-key', type: 'secret', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', type: 'secret', re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { id: 'github-token', type: 'secret', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-pat', type: 'secret', re: /github_pat_[A-Za-z0-9_]{40,}/g },
  { id: 'slack-token', type: 'secret', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', type: 'secret', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'google-api-key', type: 'secret', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'stripe-key', type: 'secret', re: /[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { id: 'private-key', type: 'secret', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { id: 'chilean-rut', type: 'pii', re: /\b\d{1,2}\.\d{3}\.\d{3}-[\dkK]\b/g },
];

// A secret-named variable assigned a realistic *quoted literal* (not a
// placeholder, env reference, or code identifier — those are the common FPs).
const ASSIGN_RE =
  /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY))\b\s*[=:]\s*(['"])([^'"$<{][^'"]{11,})\2/g;

function redact(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

export interface ScanOptions {
  /** Extra literal strings to forbid (names/codenames). Case-insensitive. */
  forbidden?: string[];
}

/** Scan arbitrary text for secrets/PII. */
export function scanText(text: string, opts: ScanOptions = {}): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      out.push({ type: rule.type, ruleId: rule.id, redacted: redact(m[0]) });
    }
  }
  ASSIGN_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ASSIGN_RE.exec(text)) !== null) {
    out.push({ type: 'secret', ruleId: `assigned:${a[1]}`, redacted: redact(a[3]) });
  }
  for (const term of opts.forbidden ?? []) {
    const t = term.trim();
    // Require >= 3 chars: a 1-2 char term ("to", "me") would match almost any
    // text and block every auto-commit (catastrophic false positives).
    if (t.length >= 3 && text.toLowerCase().includes(t.toLowerCase())) {
      out.push({ type: 'forbidden', ruleId: 'denylist', redacted: redact(t) });
    }
  }
  return out;
}

/**
 * Scan a `git diff` for secrets/PII in ADDED lines only (ignores removed and
 * context lines, and the `+++ b/file` headers).
 */
export function scanDiff(diff: string, opts: ScanOptions = {}): SecretFinding[] {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  return scanText(added, opts);
}

/** Optional operator-controlled denylist of names/codenames (gitignored). */
export function loadForbiddenStrings(projectRoot: string): string[] {
  const p = join(projectRoot, '.agents', 'config', 'forbidden-strings.txt');
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** One-line human summary of findings (already redacted). */
export function summarizeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `${f.ruleId} (${f.redacted})`).join(', ');
}
