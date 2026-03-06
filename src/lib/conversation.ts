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

/**
 * Classify an agent into a conversation role.
 * Primary: uses the role field from SQUAD.md agents table.
 * Fallback: matches against agent name (for squads without role descriptions).
 */
export function classifyAgent(agentName: string, roleDescription?: string): AgentRole | null {
  // Primary: parse the role description from SQUAD.md
  if (roleDescription) {
    const lower = roleDescription.toLowerCase();
    if (lower.includes('orchestrat') || lower.includes('triage') || lower.includes('coordinat')) return 'lead';
    if (lower.includes('scan') || lower.includes('monitor') || lower.includes('detect')) return 'scanner';
    if (lower.includes('verif') || lower.includes('review') || lower.includes('check') || lower.includes('critic')) return 'verifier';
    // Any role description that doesn't match above = worker (the default doer)
    return 'worker';
  }

  // Fallback: match against agent name (lead checked first to avoid substring collisions)
  const name = agentName.toLowerCase();
  if (name.includes('lead') || name.includes('orchestrator')) return 'lead';
  if (name.includes('scanner') || name.includes('scout') || name.includes('monitor')) return 'scanner';
  if (name.includes('verifier') || name.includes('critic') || name.includes('reviewer')) return 'verifier';
  if (name.includes('worker') || name.includes('solver') || name.includes('builder')) return 'worker';

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

/** Phrases that indicate work is done (matched case-insensitively via includes) */
const CONVERGENCE_PHRASES = [
  'pr created', 'pr merged',
  'issue closed', 'issue resolved',
  'all tasks complete', 'all items complete', 'all issues resolved',
  'nothing left to do', 'nothing remaining',
  'session complete',
  'queue empty',
  'no open issues', 'no pending tasks', 'no pending issues',
];

/** Phrases in a verifier turn that signal approval → converge */
const VERIFIER_APPROVAL_PHRASES = [
  'approved', 'lgtm', 'looks good',
  'all checks pass', 'all tests pass', 'tests pass',
  'passed', 'quality standards met',
];

/** Phrases in a verifier turn that signal rejection → continue cycle */
const VERIFIER_REJECTION_PHRASES = [
  'failed', 'rejected', 'needs fixes', 'needs changes',
  'does not pass', 'did not pass', 'failing',
];

/** Phrases that indicate more work needed */
const CONTINUATION_PHRASES = [
  'needs review', 'needs feedback', 'needs input', 'need clarification',
  'todo', 'fixme', 'blocked',
  'waiting for', 'waiting on',
  'will continue', 'will proceed', 'will work on',
  'next step',
  'in progress',
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
  const lower = content.toLowerCase();

  // Verifier turns: check approval/rejection before generic signals
  if (lastTurn.role === 'verifier') {
    const rejected = VERIFIER_REJECTION_PHRASES.some(phrase => lower.includes(phrase));
    if (rejected) {
      return { converged: false, reason: 'Verifier rejected — continuing cycle' };
    }
    const approved = VERIFIER_APPROVAL_PHRASES.some(phrase => lower.includes(phrase));
    if (approved) {
      return { converged: true, reason: 'Verifier approved' };
    }
  }

  // Continuation signals beat convergence (bias toward completing work)
  const hasContinuation = CONTINUATION_PHRASES.some(phrase => lower.includes(phrase));
  if (hasContinuation) {
    return { converged: false, reason: 'Continuation signal detected' };
  }

  const hasConvergence = CONVERGENCE_PHRASES.some(phrase => lower.includes(phrase));
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
