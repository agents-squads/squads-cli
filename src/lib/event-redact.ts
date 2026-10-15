/**
 * Redaction at write time for execution events (#1275, framework spec §10.7:
 * events are sensitive by default). Applied inside ExecEventWriter.emit() —
 * the single write point — so the events file and the API flush carry the
 * same redacted line, and every event gets a `sensitivity`.
 *
 * What is masked, in this order:
 *   1. Known values: the credentials in the local secret store
 *      (`~/.squads/secrets/`, or SQUADS_SECRETS_DIR) and in credential-named
 *      environment variables — exact matches, values of 12+ characters.
 *      Never logged, never sent.
 *   2. Patterns (REDACT_PATTERNS): PEM private-key blocks, provider token
 *      shapes (the commit scanner's rules, plus generic `sk-…`), JWTs, Bearer
 *      tokens, `key=value` pairs whose key names a password / token / secret /
 *      API key, and Chilean RUTs (personal data).
 * Each match becomes `[redacted:<kind>]`. The pattern list is part of the
 * event contract (docs/exec-events.md) so a server can re-apply it on ingest.
 *
 * Text is redacted first and cut second: a secret straddling the cut can't
 * leave a fragment behind.
 */

import { lstatSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SECRET_RULES } from './secret-scan.js';

export type Sensitivity = 'low' | 'moderate' | 'high';

/** Longest text a summary-like field keeps after redaction. */
export const SUMMARY_MAX = 200;

/** Patterns masked in every event string, in order. Exported for the contract docs and tests. */
export const REDACT_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  // The whole block, also when a cut removed its END line.
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g },
  ...SECRET_RULES.filter((r) => r.id !== 'private-key').map((r) => ({ kind: r.id, re: new RegExp(r.re.source, 'g') })),
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer', re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi },
  // key=value / key: value where the key names a credential: the value goes.
  // A reference ($VAR, $(cat …), process.env.X, <placeholder>) is not a secret and stays readable.
  { kind: 'assigned', re: /(?<=\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*["']?)(?![$<{[]|process\.env)[^\s"'&,;}]{6,}/gi },
];

/** Credential-named environment variables (their values are known secrets). */
const SECRET_ENV_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i;
const KNOWN_MIN = 12;
const FILE_MAX = 256 * 1024;

const knownCache = new Map<string, string[]>();

/** Secret strings worth masking from one secret-store file. */
function valuesIn(text: string): string[] {
  const out: string[] = [];
  try {
    // JSON (service-account keys, app credentials): the credential-named fields.
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string') {
        if (/key|secret|token|password|private|credential/i.test(key)) out.push(v);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, k);
      }
    };
    walk(JSON.parse(text));
    return out;
  } catch {
    // Not JSON: the value itself, and each line of a multi-line one (a PEM body).
    const t = text.trim();
    out.push(t);
    for (const line of t.split('\n')) if (!line.startsWith('-----')) out.push(line.trim());
    return out;
  }
}

/** The known secret values to mask, longest first. Read once per process and directory. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env.SQUADS_SECRETS_DIR || join(env.HOME || homedir(), '.squads', 'secrets');
  const hit = knownCache.get(dir);
  if (hit) return hit;
  const values = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > FILE_MAX) continue; // links and big files: skipped
        for (const v of valuesIn(readFileSync(file, 'utf8'))) if (v.length >= KNOWN_MIN) values.add(v);
      } catch {
        // unreadable: skip
      }
    }
  } catch {
    // no secret store
  }
  for (const [k, v] of Object.entries(env)) if (v && v.length >= KNOWN_MIN && SECRET_ENV_RE.test(k)) values.add(v);
  const list = [...values].sort((a, b) => b.length - a.length);
  knownCache.set(dir, list);
  return list;
}

/** For tests: forget what knownSecrets() read. */
export function resetKnownSecrets(): void {
  knownCache.clear();
}

/** `text` with known values and patterns masked; `fired` when anything was. */
export function redactText(text: string, known: readonly string[] = knownSecrets()): { text: string; fired: boolean } {
  let out = text;
  let fired = false;
  for (const v of known) {
    if (out.includes(v)) {
      out = out.split(v).join('[redacted:known]');
      fired = true;
    }
  }
  for (const { kind, re } of REDACT_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, `[redacted:${kind}]`);
      fired = true;
    }
  }
  return { text: out, fired };
}

/** Structural fields: identifiers and enums, never free text. */
const STRUCTURAL = new Set(['type', 'kind', 'tool', 'model', 'mode', 'role', 'squad', 'agent', 'childRunId', 'startedAt', 'sha256']);
/** Free-text fields cut to SUMMARY_MAX after redaction. */
const CAPPED = new Set(['summary', 'inputSummary', 'ref', 'task', 'url']);

/** How sensitive an event is when nothing was redacted. */
const BASE: Record<string, Sensitivity> = {
  run_start: 'low', context_assembled: 'low', token_usage: 'low', run_end: 'low', subagent_done: 'low',
  truncated: 'low', file_read: 'low', file_write: 'low',
};

/** An event with its text redacted and cut, and its sensitivity. */
export function redactEvent<E extends { type: string }>(event: E, known: readonly string[] = knownSecrets()): { event: E; sensitivity: Sensitivity } {
  let fired = false;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') {
      if (STRUCTURAL.has(key)) return v;
      const r = redactText(v, known);
      fired = fired || r.fired;
      return CAPPED.has(key) && r.text.length > SUMMARY_MAX ? r.text.slice(0, SUMMARY_MAX) : r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const out = walk(event, '') as E;
  return { event: out, sensitivity: fired ? 'high' : (BASE[event.type] ?? 'moderate') };
}
