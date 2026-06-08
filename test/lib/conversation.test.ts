/**
 * Tests for src/lib/conversation.ts — squad conversation protocol.
 * Pure logic, no mocking needed.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAgent,
  modelForRole,
  createTranscript,
  serializeTranscript,
  addTurn,
  detectConvergence,
  estimateTurnCost,
} from '../../src/lib/conversation.js';
import type { Transcript } from '../../src/lib/conversation.js';

// ─── classifyAgent ───────────────────────────────────────────────────────────

describe('classifyAgent', () => {
  describe('role description takes priority', () => {
    it('maps orchestrat* to lead', () => {
      expect(classifyAgent('some-agent', 'orchestrates the team')).toBe('lead');
    });
    it('maps coordinat* to lead', () => {
      expect(classifyAgent('some-agent', 'coordinates deliverables')).toBe('lead');
    });
    it('maps triage to lead', () => {
      expect(classifyAgent('some-agent', 'triages incoming issues')).toBe('lead');
    });
    it('maps scan* to scanner', () => {
      expect(classifyAgent('watcher', 'scans repos for new issues')).toBe('scanner');
    });
    it('maps monitor to scanner', () => {
      expect(classifyAgent('bot', 'monitors the pipeline')).toBe('scanner');
    });
    it('maps verif* to verifier', () => {
      expect(classifyAgent('bot', 'verifies output quality')).toBe('verifier');
    });
    it('maps review to verifier', () => {
      expect(classifyAgent('bot', 'reviews code before merge')).toBe('verifier');
    });
    it('maps check to verifier', () => {
      expect(classifyAgent('bot', 'checks all tests pass')).toBe('verifier');
    });
    it('maps any other role description to worker', () => {
      expect(classifyAgent('bot', 'builds landing pages and writes copy')).toBe('worker');
    });
  });

  describe('name-based fallback when no role description', () => {
    it('maps *lead* to lead', () => {
      expect(classifyAgent('squad-lead')).toBe('lead');
    });
    it('maps *orchestrator* to lead', () => {
      expect(classifyAgent('orchestrator')).toBe('lead');
    });
    it('maps *scanner* to scanner', () => {
      expect(classifyAgent('market-scanner')).toBe('scanner');
    });
    it('maps *scout* to scanner', () => {
      expect(classifyAgent('market-scout')).toBe('scanner');
    });
    it('maps *monitor* to scanner', () => {
      expect(classifyAgent('uptime-monitor')).toBe('scanner');
    });
    it('maps *verifier* to verifier', () => {
      expect(classifyAgent('verifier')).toBe('verifier');
    });
    it('maps *critic* to verifier', () => {
      expect(classifyAgent('code-critic')).toBe('verifier');
    });
    it('maps *reviewer* to verifier', () => {
      expect(classifyAgent('pr-reviewer')).toBe('verifier');
    });
    it('maps *worker* to worker', () => {
      expect(classifyAgent('content-worker')).toBe('worker');
    });
    it('maps *solver* to worker', () => {
      expect(classifyAgent('issue-solver')).toBe('worker');
    });
    it('maps *builder* to worker', () => {
      expect(classifyAgent('page-builder')).toBe('worker');
    });
    it('returns null for unknown agent names', () => {
      expect(classifyAgent('unknown-agent')).toBeNull();
    });
  });

  describe('Spanish role-value synonyms (#449)', () => {
    it('maps "Orquestador" role to lead', () => {
      expect(classifyAgent('finanzas-agent', 'Orquestador — coordina el squad')).toBe('lead');
    });
    it('maps "líder" role to lead', () => {
      expect(classifyAgent('agente-x', 'líder del equipo')).toBe('lead');
    });
    it('maps "escáner" role to scanner', () => {
      expect(classifyAgent('agente-x', 'escáner de oportunidades')).toBe('scanner');
    });
    it('maps "verificador" role to verifier', () => {
      expect(classifyAgent('agente-x', 'verificador de calidad')).toBe('verifier');
    });
    it('maps "crítico" role to verifier', () => {
      expect(classifyAgent('agente-x', 'crítico de entregables')).toBe('verifier');
    });
    it('maps "trabajador" role to worker (default)', () => {
      expect(classifyAgent('agente-x', 'trabajador que entrega tareas')).toBe('worker');
    });
  });

  describe('Spanish name-based synonyms (#449)', () => {
    it('maps *orquestador* name to lead', () => {
      expect(classifyAgent('orquestador-squad')).toBe('lead');
    });
    it('maps *verificador* name to verifier', () => {
      expect(classifyAgent('verificador-calidad')).toBe('verifier');
    });
    it('maps *trabajador* name to worker', () => {
      expect(classifyAgent('trabajador-1')).toBe('worker');
    });
  });
});

// ─── modelForRole ─────────────────────────────────────────────────────────────

describe('modelForRole', () => {
  it('maps lead to sonnet', () => {
    expect(modelForRole('lead')).toBe('sonnet');
  });
  it('maps worker to sonnet', () => {
    expect(modelForRole('worker')).toBe('sonnet');
  });
  it('maps scanner to haiku', () => {
    expect(modelForRole('scanner')).toBe('haiku');
  });
  it('maps verifier to haiku', () => {
    expect(modelForRole('verifier')).toBe('haiku');
  });
});

// ─── createTranscript ─────────────────────────────────────────────────────────

describe('createTranscript', () => {
  it('creates transcript with correct squad name', () => {
    const t = createTranscript('cli');
    expect(t.squad).toBe('cli');
  });
  it('starts with empty turns array', () => {
    const t = createTranscript('cli');
    expect(t.turns).toHaveLength(0);
  });
  it('starts with zero total cost', () => {
    const t = createTranscript('cli');
    expect(t.totalCost).toBe(0);
  });
  it('sets startedAt to a valid ISO timestamp', () => {
    const before = Date.now();
    const t = createTranscript('cli');
    const after = Date.now();
    const ts = new Date(t.startedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─── addTurn / serializeTranscript ───────────────────────────────────────────

describe('addTurn', () => {
  it('adds a turn to the transcript', () => {
    const t = createTranscript('cli');
    addTurn(t, 'squad-lead', 'lead', 'Here is the brief.', 0.5);
    expect(t.turns).toHaveLength(1);
  });
  it('accumulates total cost across turns', () => {
    const t = createTranscript('cli');
    addTurn(t, 'agent-a', 'worker', 'work done', 0.75);
    addTurn(t, 'agent-b', 'worker', 'more work', 0.25);
    expect(t.totalCost).toBe(1.0);
  });
  it('stores correct agent name and role', () => {
    const t = createTranscript('cli');
    addTurn(t, 'issue-solver', 'worker', 'fixed it', 0.5);
    expect(t.turns[0].agent).toBe('issue-solver');
    expect(t.turns[0].role).toBe('worker');
    expect(t.turns[0].content).toBe('fixed it');
  });
  it('sets a timestamp for each turn', () => {
    const t = createTranscript('cli');
    addTurn(t, 'lead', 'lead', 'brief', 0.5);
    expect(t.turns[0].timestamp).toBeTruthy();
    expect(new Date(t.turns[0].timestamp).getTime()).not.toBeNaN();
  });
});

describe('serializeTranscript', () => {
  it('returns empty string for transcript with no turns', () => {
    const t = createTranscript('cli');
    expect(serializeTranscript(t)).toBe('');
  });

  it('includes agent name and role in output', () => {
    const t = createTranscript('cli');
    addTurn(t, 'squad-lead', 'lead', 'Here is the brief.', 0.5);
    const out = serializeTranscript(t);
    expect(out).toContain('squad-lead');
    expect(out).toContain('lead');
    expect(out).toContain('Here is the brief.');
  });

  it('includes conversation header', () => {
    const t = createTranscript('cli');
    addTurn(t, 'agent', 'worker', 'work', 0.5);
    expect(serializeTranscript(t)).toContain('## Conversation So Far');
  });

  it('compacts after 5 turns keeping first brief and last lead review', () => {
    const t = createTranscript('cli');
    addTurn(t, 'lead', 'lead', 'Initial brief', 0.5);
    addTurn(t, 'worker', 'worker', 'Work output 1', 0.5);
    addTurn(t, 'lead', 'lead', 'Lead review A', 0.5);
    addTurn(t, 'worker', 'worker', 'Work output 2', 0.5);
    addTurn(t, 'lead', 'lead', 'Lead review B', 0.5);
    addTurn(t, 'worker', 'worker', 'Work output 3', 0.5); // 6th turn triggers compaction
    const out = serializeTranscript(t);
    // First brief preserved
    expect(out).toContain('Initial brief');
    // Last lead review preserved (B not A)
    expect(out).toContain('Lead review B');
    // Compaction note shown
    expect(out).toContain('compacted');
  });

  it('keeps all turns when 5 or fewer', () => {
    const t = createTranscript('cli');
    addTurn(t, 'lead', 'lead', 'Brief', 0.5);
    addTurn(t, 'worker', 'worker', 'Output', 0.5);
    const out = serializeTranscript(t);
    expect(out).toContain('Brief');
    expect(out).toContain('Output');
    expect(out).not.toContain('compacted');
  });
});

// ─── detectConvergence ────────────────────────────────────────────────────────

function makeTranscript(turns: Array<{ agent: string; role: 'lead' | 'worker' | 'scanner' | 'verifier'; content: string }>): Transcript {
  const t = createTranscript('cli');
  for (const turn of turns) {
    addTurn(t, turn.agent, turn.role, turn.content, 0.1);
  }
  return t;
}

describe('detectConvergence', () => {
  it('returns false when transcript has no turns', () => {
    const t = createTranscript('cli');
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(false);
  });

  it('converges when max turns reached', () => {
    const t = makeTranscript([{ agent: 'lead', role: 'lead', content: 'still working' }]);
    const result = detectConvergence(t, 1, 25);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Max turns');
  });

  it('converges when cost ceiling reached', () => {
    const t = createTranscript('cli');
    addTurn(t, 'lead', 'lead', 'expensive turn', 30);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Cost ceiling');
  });

  it('converges when convergence phrase detected', () => {
    const t = makeTranscript([{ agent: 'worker', role: 'worker', content: 'PR created. Session complete.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(true);
  });

  it('continues when continuation phrase detected (beats convergence)', () => {
    const t = makeTranscript([{ agent: 'worker', role: 'worker', content: 'PR created but still needs review and more work.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(false);
    expect(result.reason).toContain('Continuation');
  });

  it('converges when lead signals completion', () => {
    const t = makeTranscript([{ agent: 'lead', role: 'lead', content: 'All work is done. Session is complete.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Lead signaled');
  });

  it('converges when verifier approves', () => {
    const t = makeTranscript([{ agent: 'verifier', role: 'verifier', content: 'LGTM. All tests pass.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Verifier approved');
  });

  it('continues when verifier rejects', () => {
    const t = makeTranscript([{ agent: 'verifier', role: 'verifier', content: 'Tests failed. Needs fixes.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(false);
    expect(result.reason).toContain('Verifier rejected');
  });

  it('continues when no signals detected', () => {
    const t = makeTranscript([{ agent: 'worker', role: 'worker', content: 'Here is my analysis of the situation.' }]);
    const result = detectConvergence(t, 20, 25);
    expect(result.converged).toBe(false);
    expect(result.reason).toContain('No signals');
  });
});

// ─── estimateTurnCost ─────────────────────────────────────────────────────────

describe('estimateTurnCost', () => {
  it('returns opus cost for opus model', () => {
    expect(estimateTurnCost('claude-opus-4')).toBe(2.50);
  });
  it('returns haiku cost for haiku model', () => {
    expect(estimateTurnCost('claude-haiku-4-5')).toBe(0.10);
  });
  it('returns sonnet cost for sonnet model', () => {
    expect(estimateTurnCost('claude-sonnet-4-6')).toBe(0.75);
  });
  it('defaults to sonnet cost for unknown model', () => {
    expect(estimateTurnCost('unknown-model')).toBe(0.75);
  });
  it('returns sonnet cost when model string is empty', () => {
    expect(estimateTurnCost('')).toBe(0.75);
  });
});
