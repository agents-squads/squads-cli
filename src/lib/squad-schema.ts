/**
 * SQUAD.md frontmatter schema check (squads framework spec §5).
 *
 * The schema lives in schemas/squad.schema.json — the single source, also
 * usable by editors. This module interprets the subset of JSON Schema that
 * file uses (type, enum, properties, required, additionalProperties, items,
 * minItems, minLength, minimum) so the CLI needs no validator dependency.
 *
 * Errors: a block the schema defines holds something it doesn't allow.
 * Hints: legacy fields that still work but belong in one of the four blocks,
 * and keys the schema doesn't know. Hints never fail a check. The runtime
 * still reads the legacy fields — don't migrate until it reads the blocks.
 */

import schemaJson from '../../schemas/squad.schema.json';

interface Schema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
}

export interface SchemaIssue {
  /** Dotted path in the frontmatter, e.g. `cost.budget.daily_usd`. */
  path: string;
  message: string;
}

export interface SquadSchemaResult {
  errors: SchemaIssue[];
  hints: SchemaIssue[];
}

export const SQUAD_SCHEMA = schemaJson as unknown as Schema;

/** Legacy flat fields → where they live in the four-block shape. */
const LEGACY_TOP_LEVEL: Record<string, string> = {
  repo: 'org.repos',
  also_owns: 'org.repos',
  domain: 'org.domain',
  depends_on: 'org.depends_on',
  lead: 'org.owner (a human) / org.members',
  conversation_agents: 'org.members',
  kpis: 'org.goals (each with a check)',
  permissions: 'behavior.permissions',
  providers: 'cost.lanes',
  effort: 'cost.models',
};

/** Legacy keys inside `context` that the spec moves to other blocks. */
const LEGACY_IN_CONTEXT: Record<string, string> = {
  model: 'cost.models',
  budget: 'cost.budget (daily_usd / weekly_usd / per_run_usd)',
  cooldown: 'behavior.cooldown_s',
};

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: NonNullable<Schema['type']>): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function check(value: unknown, schema: Schema, path: string, errors: SchemaIssue[]): void {
  const at = path || '(root)';
  if (schema.enum && !schema.enum.some(e => e === value)) {
    errors.push({ path: at, message: `must be one of: ${schema.enum.map(e => JSON.stringify(e)).join(', ')}` });
    return;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({ path: at, message: `must be ${schema.type === 'array' || schema.type === 'object' ? 'an' : 'a'} ${schema.type}, got ${typeOf(value)}` });
    return;
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path: at, message: 'must not be empty' });
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: at, message: `must be ≥ ${schema.minimum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: at, message: `needs at least ${schema.minItems} item(s)` });
    }
    if (schema.items) value.forEach((item, i) => check(item, schema.items!, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
    }
    for (const [key, v] of Object.entries(obj)) {
      const child = path ? `${path}.${key}` : key;
      const prop = schema.properties?.[key];
      if (prop) check(v, prop, child, errors);
      else if (schema.additionalProperties === false) errors.push({ path: child, message: 'is not part of this block' });
      else if (typeof schema.additionalProperties === 'object') check(v, schema.additionalProperties, child, errors);
    }
  }
}

/**
 * Check SQUAD.md frontmatter against the schema. Legacy fields are reported
 * as hints (with where they belong) and kept out of the strict check, so an
 * existing squad stays valid while it migrates.
 */
export function validateSquadFrontmatter(frontmatter: Record<string, unknown>): SquadSchemaResult {
  const hints: SchemaIssue[] = [];
  const known = SQUAD_SCHEMA.properties ?? {};
  const strict: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'context' && typeOf(value) === 'object') {
      const ctx = { ...(value as Record<string, unknown>) };
      for (const [legacy, target] of Object.entries(LEGACY_IN_CONTEXT)) {
        if (legacy in ctx) {
          hints.push({ path: `context.${legacy}`, message: `becomes ${target} in the four-block format` });
          delete ctx[legacy];
        }
      }
      strict.context = ctx;
    } else if (key === 'status' && value === 'frozen') {
      // Older squads say `frozen`; the runtime state is `paused`.
      hints.push({ path: 'status', message: 'legacy value "frozen" — use "paused"' });
    } else if (key in known) {
      strict[key] = value;
    } else if (key in LEGACY_TOP_LEVEL) {
      hints.push({ path: key, message: `becomes ${LEGACY_TOP_LEVEL[key]} in the four-block format` });
    } else {
      hints.push({ path: key, message: 'not part of the schema' });
    }
  }

  const errors: SchemaIssue[] = [];
  check(strict, SQUAD_SCHEMA, '', errors);
  return { errors, hints };
}
