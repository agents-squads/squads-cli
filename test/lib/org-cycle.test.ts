import { describe, it, expect, vi } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(() => '/project/.agents/squads'),
  loadSquad: vi.fn(() => null),
  findProjectRoot: vi.fn(() => '/project'),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => '/project/.agents/memory'),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '' },
  bold: '',
  RESET: '',
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { planOrgCycle } from '../../src/lib/org-cycle.js';
import type { OrgScanResult } from '../../src/lib/org-cycle.js';

// ── Tests: planOrgCycle ───────────────────────────────────────────────────────
describe('planOrgCycle', () => {
  it('includes active squads with a lead', () => {
    const scan: OrgScanResult[] = [
      { squad: 'engineering', status: 'healthy', goalsActive: 2, lastExecution: null, lead: 'eng-lead', repo: null, reason: '2 active goals' },
    ];
    const plan = planOrgCycle(scan);
    expect(plan).toHaveLength(1);
    expect(plan[0].squad).toBe('engineering');
  });

  it('excludes frozen squads', () => {
    const scan: OrgScanResult[] = [
      { squad: 'marketing', status: 'frozen', goalsActive: 0, lastExecution: null, lead: 'mkt-lead', repo: null, reason: 'Paused: reason' },
      { squad: 'engineering', status: 'healthy', goalsActive: 2, lastExecution: null, lead: 'eng-lead', repo: null, reason: '2 active goals' },
    ];
    const plan = planOrgCycle(scan);
    expect(plan).toHaveLength(1);
    expect(plan[0].squad).toBe('engineering');
  });

  it('excludes squads with no lead', () => {
    const scan: OrgScanResult[] = [
      { squad: 'engineering', status: 'healthy', goalsActive: 2, lastExecution: null, lead: null, repo: null, reason: '2 active goals' },
    ];
    const plan = planOrgCycle(scan);
    expect(plan).toHaveLength(0);
  });

  it('treats a paused-squad frozen entry like any other frozen entry', () => {
    // This is what scanOrg produces for a paused squad: status='frozen', reason contains 'Paused'
    const scan: OrgScanResult[] = [
      {
        squad: 'cli',
        status: 'frozen',
        goalsActive: 1,
        lastExecution: null,
        lead: 'cli-lead',
        repo: null,
        reason: 'Paused since 2026-06-14: waiting for design',
      },
    ];
    const plan = planOrgCycle(scan);
    expect(plan).toHaveLength(0);
  });
});
