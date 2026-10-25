/**
 * Minimal JSON Schema validator for the subset `schema/*.json` uses (issue #130).
 *
 * The on-disk event format is the source of truth (§12.2), so it must be DATA:
 * a JSON Schema checked by a validator that lives in this tree — zero runtime
 * dependencies — instead of one hand-kept TypeScript copy of the same contract.
 *
 * Supported per document: `$ref` (internal `#/definitions/…`), `const`,
 * `enum`, `type` (string or array), `required`, `properties`,
 * `additionalProperties: false`, `items`, `oneOf` (discriminated by shape),
 * `minimum`, `minLength` and `minItems`, and `format: "date-time"` (a strict
 * RFC 3339 regex — a fast regex, not `Date.parse`, which is lenient enough to
 * accept garbage). Everything else is ignored, which is fine: the
 * schema stays within this subset, and a keyword outside it cannot be
 * load-bearing.
 */

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * RFC 3339 date-time, shape-checked with gregorian ranges. `Date.parse`
 * is deliberately NOT used here: it accepts across-the-map junk, and the
 * format keyword exists so a mangled `ts`/`startedAt` stamp fails loudly
 * instead of validating clean.
 */
const DATE_TIME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export type JsonSchema = Record<string, unknown>;
export type Definitions = Record<string, JsonSchema>;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function jsonType(x: unknown): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}

function typeNames(want: unknown): string[] {
  if (typeof want === 'string') return [want];
  if (Array.isArray(want)) return want.filter((x): x is string => typeof x === 'string');
  return [];
}

function checkType(want: unknown, data: unknown, path: string, issues: ValidationIssue[]): boolean {
  const names = typeNames(want);
  if (names.length === 0) return true;
  const got = jsonType(data);
  const ok = names.some(n => n === got || (n === 'integer' && got === 'number' && Number.isInteger(data)));
  if (!ok) issues.push({ path, message: `expected type ${names.join('|')}, got ${got}` });
  return ok;
}

/** Equality, for `const` and `enum`: JSON values, not identity. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => equal(a[k], b[k]));
  }
  return false;
}

const DEFINITIONS_PREFIX = '#/definitions/';

function check(schema: unknown, data: unknown, path: string, defs: Definitions, issues: ValidationIssue[]): void {
  if (!isObject(schema)) {
    if (schema === false) issues.push({ path, message: 'not allowed' });
    return; // `true` (or absent) accepts everything
  }
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.startsWith(DEFINITIONS_PREFIX) ? ref.slice(DEFINITIONS_PREFIX.length) : undefined;
    const target = name !== undefined ? defs[name] : undefined;
    if (target) return check(target, data, path, defs, issues);
    issues.push({ path, message: `unknown $ref ${ref}` });
    return;
  }
  if (ref !== undefined) {
    issues.push({ path, message: 'unsupported $ref' });
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    // The event union: branches differ by required properties (the `type`
    // const), so exactly one must accept — not zero (unknown shape), not two.
    const candidates: { sub: ValidationIssue[] }[] = [];
    for (const branch of schema.oneOf) {
      const sub: ValidationIssue[] = [];
      check(branch, data, path, defs, sub);
      candidates.push({ sub });
    }
    const matches = candidates.filter(c => c.sub.length === 0);
    if (matches.length !== 1) {
      issues.push({ path, message: `expected exactly one option to match (${matches.length} of ${schema.oneOf.length} did)` });
      if (matches.length === 0) {
        // Name the drift: the closest branch (fewest own problems) explains why
        // the data was rejected, e.g. the required field a writer lost.
        const closest = candidates.reduce((best, c) => (c.sub.length < best.sub.length ? c : best));
        issues.push(...closest.sub);
      }
    }
    return; // in our subset oneOf is never combined with sibling keywords
  }
  if (checkType(schema.type, data, path, issues)) {
    // Only descend when the type matched: a string cannot have properties.
    if ('const' in schema && !equal(schema.const, data)) {
      issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(v => equal(v, data))) {
      issues.push({ path, message: `expected one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}` });
    }
    if (isObject(data)) {
      if (Array.isArray(schema.required)) {
        for (const key of schema.required.filter((k): k is string => typeof k === 'string')) {
          if (!(key in data)) issues.push({ path, message: `missing required property "${key}"` });
        }
      }
      if (isObject(schema.properties)) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (key in data) check(sub, data[key], `${path}/${key}`, defs, issues);
        }
      }
      if (schema.additionalProperties === false) {
        const known = isObject(schema.properties) ? Object.keys(schema.properties) : [];
        for (const key of Object.keys(data)) {
          if (!known.includes(key)) issues.push({ path, message: `unknown property "${key}"` });
        }
      }
    }
    if (Array.isArray(data) && isObject(schema.items)) {
      data.forEach((item, i) => check(schema.items, item, `${path}/${i}`, defs, issues));
    }
  }
  if (typeof schema.minimum === 'number' && typeof data === 'number' && data < schema.minimum) {
    issues.push({ path, message: `expected >= ${schema.minimum}` });
  }
  if (typeof schema.minLength === 'number' && typeof data === 'string' && data.length < schema.minLength) {
    issues.push({ path, message: `expected at least ${schema.minLength} characters` });
  }
  if (typeof schema.minItems === 'number' && Array.isArray(data) && data.length < schema.minItems) {
    issues.push({ path, message: `expected at least ${schema.minItems} items` });
  }
  if (schema.format === 'date-time') {
    if (typeof data !== 'string') {
      issues.push({ path, message: `expected a date-time string, got ${jsonType(data)}` });
    } else if (!DATE_TIME.test(data)) {
      issues.push({ path, message: `not a valid RFC 3339 date-time: ${JSON.stringify(data.slice(0, 40))}` });
    }
  }
}

/**
 * Validate `data` against `schema`. `defs` is the schema document's
 * `definitions` (each entry must itself be a schema); `$ref`s only reach in
 * there. Returns the issues found — empty means valid.
 */
export function validate(schema: unknown, data: unknown, defs: Definitions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  check(schema, data, '$', defs, issues);
  return issues;
}
