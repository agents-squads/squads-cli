/**
 * Squad Conversation Protocol — Types, transcript management, and convergence detection.
 *
 * Agents share a conversation transcript. Lead briefs first, workers execute,
 * lead iterates with workers until quality converges, verifiers check final output.
 * CLI manages turns (deterministic), lead manages content (creative).
 */

// =============================================================================
// Agent Classification
// =============================================================================

export type AgentRole = 'lead' | 'scanner' | 'worker' | 'verifier';

const ROLE_PATTERNS: Record<AgentRole, RegExp> = {
  scanner: /scanner|scout|monitor/i,
  worker: /worker|researcher|poster|solver|writer|analyst|builder/i,
  lead: /lead|orchestrator/i,
  verifier: /verifier|critic|eval|reviewer/i,
};

/** Classify an agent name into a conversation role */
export function classifyAgent(agentName: string): AgentRole | null {
  for (const [role, pattern] of Object.entries(ROLE_PATTERNS)) {
    if (pattern.test(agentName)) return role as AgentRole;
  }
  return null; // Unclassified — excluded from conversation
}

/** Map roles to model tiers for cost routing */
export function modelForRole(role: AgentRole): string {
  switch (role) {
    case 'lead': return 'sonnet';
    case 'worker': return 'sonnet';
    case 'scanner': return 'haiku';
    case 'verifier': return 'haiku';
  }
}

// =============================================================================
// Transcript
// =============================================================================

export interface Turn {
  /** Which agent produced this turn */
  agent: string;
  /** Classified role */
  role: AgentRole;
  /** The agent's full output */
  content: string;
  /** Timestamp */
  timestamp: string;
  /** Estimated cost for this turn */
  estimatedCost: number;
}

export interface Transcript {
  squad: string;
  turns: Turn[];
  startedAt: string;
  /** Running cost estimate */
  totalCost: number;
}

export function createTranscript(squad: string): Transcript {
  return {
    squad,
    turns: [],
    startedAt: new Date().toISOString(),
    totalCost: 0,
  };
}

/** Serialize transcript for prompt injection */
export function serializeTranscript(transcript: Transcript): string {
  if (transcript.turns.length === 0) return '';

  const lines = ['## Conversation So Far\n'];
  for (const turn of transcript.turns) {
    lines.push(`### ${turn.agent} (${turn.role}) — ${turn.timestamp}`);
    lines.push(turn.content);
    lines.push('');
  }
  return lines.join('\n');
}

export function addTurn(
  transcript: Transcript,
  agent: string,
  role: AgentRole,
  content: string,
  estimatedCost: number,
): void {
  transcript.turns.push({
    agent,
    role,
    content,
    timestamp: new Date().toISOString(),
    estimatedCost,
  });
  transcript.totalCost += estimatedCost;
}

// =============================================================================
// Convergence Detection
// =============================================================================

/** Signals that indicate work is done */
const CONVERGENCE_SIGNALS = [
  /PR\s*#?\d+\s*created/i,
  /issue\s*#?\d+\s*(closed|resolved)/i,
  /all\s*(tasks?|items?|issues?)\s*(complete|done|resolved)/i,
  /nothing\s*(left|remaining|more)\s*to\s*(do|process)/i,
  /session\s*complete/i,
  /queue\s*empty/i,
  /no\s*(open|pending)\s*(issues?|tasks?|items?)/i,
];

/** Signals that indicate more work needed */
const CONTINUATION_SIGNALS = [
  /needs?\s*(review|feedback|input|clarification)/i,
  /TODO|FIXME|BLOCKED/,
  /waiting\s*(for|on)/i,
  /will\s*(continue|proceed|work\s*on)/i,
  /next\s*step/i,
  /in\s*progress/i,
];

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
}

/**
 * Detect if the conversation has converged.
 * Continuation signals beat convergence signals (bias toward more work).
 */
export function detectConvergence(
  transcript: Transcript,
  maxTurns: number,
  costCeiling: number,
): ConvergenceResult {
  // Hard limits
  if (transcript.turns.length >= maxTurns) {
    return { converged: true, reason: `Max turns reached (${maxTurns})` };
  }
  if (transcript.totalCost >= costCeiling) {
    return { converged: true, reason: `Cost ceiling reached ($${transcript.totalCost.toFixed(2)}/$${costCeiling})` };
  }

  // Check last turn content
  if (transcript.turns.length === 0) {
    return { converged: false, reason: 'No turns yet' };
  }

  const lastTurn = transcript.turns[transcript.turns.length - 1];
  const content = lastTurn.content;

  // Continuation signals beat convergence (bias toward completing work)
  const hasContinuation = CONTINUATION_SIGNALS.some(p => p.test(content));
  if (hasContinuation) {
    return { converged: false, reason: 'Continuation signal detected' };
  }

  const hasConvergence = CONVERGENCE_SIGNALS.some(p => p.test(content));
  if (hasConvergence) {
    return { converged: true, reason: 'Convergence signal detected' };
  }

  return { converged: false, reason: 'No signals detected, continuing' };
}

// =============================================================================
// Cost Estimation
// =============================================================================

/** Rough cost estimates per model per turn (input + output) */
const COST_PER_TURN: Record<string, number> = {
  opus: 2.50,
  sonnet: 0.75,
  haiku: 0.10,
};

export function estimateTurnCost(model: string): number {
  const key = model.includes('opus') ? 'opus'
    : model.includes('haiku') ? 'haiku'
    : 'sonnet';
  return COST_PER_TURN[key] || COST_PER_TURN.sonnet;
}
