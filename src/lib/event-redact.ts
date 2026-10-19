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

import { lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SECRET_RULES } from './secret-scan.js';

export type Sensitivity = 'low' | 'moderate' | 'high';

/** Longest text a summary-like field keeps after redaction. */
export const SUMMARY_MAX = 200;

/** Patterns masked in every event string, in order. Exported for the contract docs and tests.
 *  Every lookbehind has a bounded prefix: no input makes them slow. */
export const REDACT_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  // The whole block (RSA, EC, OPENSSH, ENCRYPTED, PGP …), also when a cut removed its END line.
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  ...SECRET_RULES.filter((r) => r.id !== 'private-key').map((r) => ({ kind: r.id, re: new RegExp(r.re.source, 'g') })),
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'pypi-token', re: /\bpypi-[A-Za-z0-9_-]{40,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // user:password@host in any URL (git remotes, DATABASE_URL).
  { kind: 'url-credential', re: /(?<=\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,64}:)[^\s@/]{1,128}(?=@)/gi },
  // Authorization: <scheme> <credential> — Bearer, token, Basic, Digest, or none.
  { kind: 'authorization', re: /(?<=\bauthorization["']?\s{0,4}[:=]\s{0,4}["']?(?:[A-Za-z]{1,10}\s{1,4})?)[A-Za-z0-9._~+/=-]{8,}/gi },
  { kind: 'bearer', re: /(?<=\bBearer\s{1,4})[A-Za-z0-9._~+/=-]{8,}/gi },
  // --password X, --token=X, -pSECRET (mysql style, no space).
  { kind: 'flag', re: /(?<=(?:^|\s)--?(?:password|passwd|pass|pwd|token|secret|api-?key|auth)(?:=|\s{1,2}))[^\s"'-][^\s"']{5,}/gi },
  { kind: 'flag', re: /(?<=\s-p)[^\s"'-][^\s"']{5,}/g },
  // ?key=…, &sig=… in a query string.
  { kind: 'query', re: /(?<=[?&](?:key|sig|signature|code|token|access_token|api_key|apikey|password)=)[^&\s"'#]{6,}/gi },
  // key=value / key: value where the key names a credential: the value goes.
  // A reference ($VAR, $(cat …), process.env.X, <placeholder>) is not a secret and stays readable.
  { kind: 'assigned', re: /(?<=\b[A-Za-z0-9_.-]{0,40}(?:password|passwd|pass|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credentials?)["']?\s{0,4}[=:]\s{0,4}["']?)(?![$<{[]|process\.env)[^\s"'&,;}]{6,}/gi },
  // Chilean RUT without dots (the dotted form is in the shared rules).
  { kind: 'chilean-rut', re: /\b\d{7,8}-[\dkK]\b/g },
];

/** Longest text redacted as is; the rest is dropped (an event is never this long by design). */
export const REDACT_INPUT_MAX = 32 * 1024;

/** Credential-named environment variables (their values are known secrets). */
const SECRET_ENV_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i;
const KNOWN_MIN = 8;
const FILE_MAX = 256 * 1024;

const knownCache = new Map<string, { mtime: number; list: string[] }>();

/** The forms a known value takes in text: as is, JSON-escaped, URL-encoded. */
function forms(v: string): string[] {
  const json = JSON.stringify(v).slice(1, -1);
  let uri = v;
  try {
    uri = encodeURIComponent(v);
  } catch {
    // a lone surrogate: the plain form only
  }
  return [...new Set([v, json, uri])];
}

function mtimeOf(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return -1;
  }
}

/** Secret strings worth masking from one secret-store file. */
function valuesIn(text: string): string[] {
  const out: string[] = [];
  try {
    // JSON (service-account keys, app credentials): the credential-named fields.
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string') {
        if (/key|secret|token|pass|pwd|private|credential|pem|auth/i.test(key)) out.push(v);
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

/** The known secret values to mask (each in its plain, JSON-escaped and URL-encoded form), longest
 *  first. Read again when the store directory changes (a secret added mid-run is picked up). */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env.SQUADS_SECRETS_DIR || join(env.HOME || homedir(), '.squads', 'secrets');
  const mtime = mtimeOf(dir);
  const hit = knownCache.get(dir);
  if (hit && hit.mtime === mtime) return hit.list;
  const values = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > FILE_MAX) continue; // links and big files: skipped
        for (const v of valuesIn(readFileSync(file, 'utf8'))) if (v.length >= KNOWN_MIN) for (const f of forms(v)) values.add(f);
      } catch {
        // unreadable: skip
      }
    }
  } catch {
    // no secret store
  }
  for (const [k, v] of Object.entries(env)) if (v && v.length >= KNOWN_MIN && SECRET_ENV_RE.test(k)) for (const f of forms(v)) values.add(f);
  const list = [...values].sort((a, b) => b.length - a.length);
  knownCache.set(dir, { mtime, list });
  return list;
}

/** For tests: forget what knownSecrets() read. */
export function resetKnownSecrets(): void {
  knownCache.clear();
}

/** `text` with known values and patterns masked; `fired` when anything was. */
export function redactText(text: string, known: readonly string[] = knownSecrets()): { text: string; fired: boolean } {
  let out = text.length > REDACT_INPUT_MAX ? `${text.slice(0, REDACT_INPUT_MAX)}…[cut]` : text;
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

/** Fields that are never redacted: the event type, a hash, a timestamp. Everything else is —
 *  identifiers included (a tool name or an agent name can carry a value too). */
const STRUCTURAL = new Set(['type', 'startedAt', 'sha256']);
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
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'string') {
      if (STRUCTURAL.has(key)) return v;
      const r = redactText(v, known);
      fired = fired || r.fired;
      return CAPPED.has(key) && r.text.length > SUMMARY_MAX ? r.text.slice(0, SUMMARY_MAX) : r.text;
    }
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  const out = walk(event, '') as E;
  return { event: out, sensitivity: fired ? 'high' : (BASE[event.type] ?? 'moderate') };
}
