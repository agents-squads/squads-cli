import { describe, it, expect } from 'vitest';
import {
  deriveContract,
  validateContract,
  isEnforceableTool,
  type ContractFrontmatter,
} from '../src/lib/agent-contract.js';
import type { ContextRole } from '../src/lib/run-context.js';

function derive(role: ContextRole, fm: ContractFrontmatter = {}) {
  return deriveContract({
    agent: `${role}-agent`, squad: 'growth', role, frontmatter: fm,
    agentFile: `growth/${role}.md`, squadFile: 'growth/SQUAD.md',
  });
}

describe('deriveContract — maps existing frontmatter + role defaults', () => {
  it('derives a scoped, read-only contract for scanner/verifier', () => {
    const c = derive('scanner');
    expect(c.role).toBe('scanner');
    expect(c.tool_grants.every((t) => t.sensitivity === 'read')).toBe(true);
    expect(c.write_scope).toEqual([]); // no write grants → no write scope
    // L0–L6 taxonomy (#1049): scanner gets [0=SYSTEM, 1=Company, 2=Goals, 3=Agent, 4=State].
    // Layer 2 (priorities) was eliminated per the single-strategy-file change (cli#876);
    // goals remain the ordering source. Digest layers (9, 10) retired (#1188).
    expect(c.scoped_context.layers).toEqual([0, 1, 2, 3, 4]);
    expect(c.default).toBe('deny');
    expect(c.workspace_id).toBe('local');
  });

  it('maps budget + timeout + context_from from frontmatter', () => {
    const c = derive('lead', {
      budget: { per_run: 2, daily: 4, monthly: 35 },
      timeout: 900,
      context_from: ['marketing', 'customer'],
      max_context_tokens: 5000,
    });
    expect(c.resource_ceiling).toMatchObject({ per_run_usd: 2, daily_usd: 4, monthly_usd: 35, max_runtime_s: 900 });
    expect(c.scoped_context.context_from).toEqual(['marketing', 'customer']);
    expect(c.scoped_context.token_budget).toBe(5000); // override wins
  });

  it('gives writers a default write_scope and a default cost ceiling', () => {
    const c = derive('worker'); // no budget declared
    expect(c.tool_grants.some((t) => t.sensitivity === 'write')).toBe(true);
    expect(c.write_scope).toEqual(['.agents/memory/growth/**']);
    expect(c.resource_ceiling.per_run_usd).toBeGreaterThan(0); // role default
    expect(c.resource_ceiling.max_runtime_s).toBe(900);
  });
});

describe('validateContract — every derived role contract is valid', () => {
  it.each<ContextRole>(['scanner', 'worker', 'lead', 'coo', 'verifier'])('%s passes', (role) => {
    expect(validateContract(derive(role))).toEqual([]);
  });
  it('a real-shaped lead (growth-lead.md) passes', () => {
    const c = derive('lead', { budget: { per_run: 2, daily: 4, monthly: 35 }, timeout: 900, context_from: ['marketing'] });
    expect(validateContract(c)).toEqual([]);
  });
});

describe('validateContract — catches over-scoped / unenforceable contracts', () => {
  it('rejects a tool grant outside the allowedTools vocabulary', () => {
    const c = derive('worker', { tool_grants: [{ tool: 'DoAnything', sensitivity: 'read' }] });
    expect(validateContract(c).some((x) => x.field === 'tool_grants')).toBe(true);
  });
  it('rejects a write grant with no write_scope (unjailed write)', () => {
    const c = derive('worker', {
      tool_grants: [{ tool: 'Write', sensitivity: 'write' }], write_scope: [],
    });
    expect(validateContract(c).some((x) => x.field === 'write_scope')).toBe(true);
  });
  it('rejects a consequential grant with hitl_gate "none"', () => {
    const c = derive('lead', {
      tool_grants: [{ tool: 'Bash(gh:*)', sensitivity: 'consequential' }],
      write_scope: ['.agents/memory/growth/**'], hitl_gate: 'none',
    });
    expect(validateContract(c).some((x) => x.field === 'hitl_gate')).toBe(true);
  });
  it('rejects an unbounded run (no max_runtime, no cost ceiling)', () => {
    const c = derive('scanner');
    c.resource_ceiling = {}; // simulate stripped ceilings
    const viol = validateContract(c);
    expect(viol.some((x) => x.field === 'resource_ceiling.max_runtime_s')).toBe(true);
    expect(viol.some((x) => x.field === 'resource_ceiling')).toBe(true);
  });
  it('rejects an unknown credential', () => {
    const c = derive('worker', { credential_scope: ['MY_SECRET_KEY'] });
    expect(validateContract(c).some((x) => x.field === 'credential_scope')).toBe(true);
  });
  it('rejects autonomy=autonomous together with a gate (contradiction)', () => {
    const c = derive('lead', { autonomy: 'autonomous' });
    expect(validateContract(c).some((x) => x.field === 'autonomy')).toBe(true);
  });
});

describe('isEnforceableTool — Claude Code allowedTools vocabulary', () => {
  it('accepts tool names, Bash(cmd:*), and mcp__server__tool', () => {
    expect(isEnforceableTool('Read')).toBe(true);
    expect(isEnforceableTool('Bash(git:*)')).toBe(true);
    expect(isEnforceableTool('Bash(squads:*)')).toBe(true);
    expect(isEnforceableTool('mcp__erp__list_overdue')).toBe(true);
    expect(isEnforceableTool('mcp__widgets__*')).toBe(true);
  });
  it('rejects free-form / unenforceable grants', () => {
    expect(isEnforceableTool('DoAnything')).toBe(false);
    expect(isEnforceableTool('Bash')).toBe(true); // bare Bash is a real (broad) tool name
    expect(isEnforceableTool('rm -rf')).toBe(false);
  });
});
