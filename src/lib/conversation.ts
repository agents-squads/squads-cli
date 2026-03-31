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
  // Name-based classification FIRST — more reliable than parsing ambiguous
  // role descriptions (e.g. "review PRs" in eng-lead ≠ verifier).
  const name = agentName.toLowerCase();
  if (name.includes('lead') || name.includes('orchestrator')) return 'lead';
  if (name.includes('scanner') || name.includes('scout') || name.includes('monitor')) return 'scanner';
  if (name.includes('verifier') || name.includes('critic') || name.includes('reviewer')) return 'verifier';
  if (name.includes('worker') || name.includes('solver') || name.includes('builder')) return 'worker';

  // Fallback: parse role description from SQUAD.md
  if (roleDescription) {
    const lower = roleDescription.toLowerCase();
    if (lower.includes('orchestrat') || lower.includes('triage') || lower.includes('coordinat') || lower.includes('lead')) return 'lead';
    if (lower.includes('scan') || lower.includes('monitor') || lower.includes('detect')) return 'scanner';
    if (lower.includes('verif') || lower.includes('critic')) return 'verifier';
    return 'worker';
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

/** Max total chars for serialized transcript. Triggers aggressive compaction. */
const MAX_TRANSCRIPT_CHARS = 20000;

/**
 * Serialize transcript for prompt injection with auto-compaction.
 *
 * Strategy (inspired by Claude Code's auto-compact):
 * - Recent turns (current cycle): kept in full
 * - Older cycles: compressed into a structured digest
 * - Digest format: what was done, what was decided, what's pending
 *
 * This lets conversations go 20+ turns without blowing context.
 */
export function serializeTranscript(transcript: Transcript): string {
  if (transcript.turns.length === 0) return '';

  const turns = transcript.turns;

  // Find cycle boundaries (each lead turn after the first starts a new cycle)
  const cycleBoundaries: number[] = [0];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].role === 'lead' && i > 0) {
      // A lead turn that follows a verifier or is the first lead after workers = new cycle
      const prevRole = turns[i - 1]?.role;
      if (prevRole === 'verifier' || prevRole === 'worker') {
        cycleBoundaries.push(i);
      }
    }
  }

  // If short conversation (≤6 turns or single cycle), return everything
  if (turns.length <= 6 || cycleBoundaries.length <= 1) {
    return formatTurns(turns, transcript.turns.length);
  }

  // Split into: old cycles (digest) + current cycle (full)
  const lastCycleStart = cycleBoundaries[cycleBoundaries.length - 1];
  const currentCycleTurns = turns.slice(lastCycleStart);
  const oldTurns = turns.slice(0, lastCycleStart);

  // Build digest of old cycles
  const digest = buildDigest(oldTurns, cycleBoundaries.slice(0, -1));

  // Assemble
  const lines = ['## Conversation So Far\n'];

  if (digest) {
    lines.push('### Prior Cycles (digest)');
    lines.push(digest);
    lines.push('');
  }

  lines.push(`### Current Cycle (${currentCycleTurns.length} turns)\n`);
  for (const turn of currentCycleTurns) {
    lines.push(`**${turn.agent} (${turn.role}):**`);
    lines.push(turn.content);
    lines.push('');
  }

  const result = lines.join('\n');

  // Safety: if still too large, truncate from the beginning of the digest
  if (result.length > MAX_TRANSCRIPT_CHARS) {
    const overflow = result.length - MAX_TRANSCRIPT_CHARS;
    return '*(transcript truncated — ' + overflow + ' chars removed from older cycles)*\n\n' +
      result.slice(overflow);
  }

  return result;
}

/** Build a structured digest from completed cycles. */
function buildDigest(turns: Turn[], cycleBoundaries: number[]): string {
  const sections: string[] = [];

  for (let c = 0; c < cycleBoundaries.length; c++) {
    const start = cycleBoundaries[c];
    const end = c + 1 < cycleBoundaries.length ? cycleBoundaries[c + 1] : turns.length;
    const cycleTurns = turns.slice(start, end);

    // Extract key signals from each role
    const done: string[] = [];
    const pending: string[] = [];
    const blocked: string[] = [];

    for (const t of cycleTurns) {
      const lines = t.content.split('\n');
      for (const line of lines) {
        const l = line.trim();
        // Extract PR numbers, issue numbers, key actions
        if (/PR\s*#\d+|merged|MERGED/.test(l) && l.length < 200) {
          done.push(l.replace(/^[-*]\s*/, '').slice(0, 100));
        }
        if (/BLOCKED|blocked|needs:human/i.test(l) && l.length < 200) {
          blocked.push(l.replace(/^[-*]\s*/, '').slice(0, 100));
        }
        if (/## STATUS:\s*CONTINUE|Remaining:|todo|not-started/i.test(l)) {
          pending.push(l.replace(/^[-*]\s*/, '').slice(0, 100));
        }
      }
    }

    // Verifier verdict
    const verifierTurn = cycleTurns.find(t => t.role === 'verifier');
    const verdict = verifierTurn
      ? (/APPROVED|approved|lgtm/i.test(verifierTurn.content) ? 'APPROVED' : 'REJECTED')
      : 'no verifier';

    const cycleLines: string[] = [`**Cycle ${c + 1}** (${verdict}):`];
    if (done.length > 0) cycleLines.push(`  Done: ${done.slice(0, 3).join('; ')}`);
    if (blocked.length > 0) cycleLines.push(`  Blocked: ${blocked.slice(0, 2).join('; ')}`);
    if (pending.length > 0) cycleLines.push(`  Pending: ${pending.slice(0, 2).join('; ')}`);

    if (done.length === 0 && blocked.length === 0 && pending.length === 0) {
      cycleLines.push(`  (${cycleTurns.length} turns, no key signals extracted)`);
    }

    sections.push(cycleLines.join('\n'));
  }

  return sections.join('\n');
}

/** Format turns as markdown for transcript injection. */
function formatTurns(turns: Turn[], totalTurns: number): string {
  const lines = ['## Conversation So Far\n'];
  if (turns.length < totalTurns) {
    lines.push(`*(${totalTurns - turns.length} earlier turns compacted)*\n`);
  }
  for (const turn of turns) {
    lines.push(`### ${turn.agent} (${turn.role}) — ${turn.timestamp}`);
    lines.push(turn.content);
    lines.push('');
  }
  return lines.join('\n');
}

/** Max chars per turn in transcript. Larger outputs are truncated with a note. */
const MAX_TURN_CHARS = 8000;

export function addTurn(
  transcript: Transcript,
  agent: string,
  role: AgentRole,
  content: string,
  estimatedCost: number,
): void {
  // Budget: cap turn content to prevent context bloat
  const trimmedContent = content.length > MAX_TURN_CHARS
    ? content.slice(0, MAX_TURN_CHARS) + `\n\n...(truncated — ${content.length} chars total. Key outputs: check git log and gh pr list for deliverables.)`
    : content;

  transcript.turns.push({
    agent,
    role,
    content: trimmedContent,
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

/** Phrases from a lead turn that signal the session is done — hard stop */
const LEAD_COMPLETION_PHRASES = [
  'session complete', 'session is complete',
  'nothing to do', 'nothing more to do', 'nothing left to do',
  'all work is done', 'all work complete', 'work is complete', 'work is done',
  'all tasks complete', 'all tasks done',
  'approved', 'approving',
  'declaring convergence', 'signaling convergence', 'signal convergence',
  'no further action', 'no further work', 'no action needed', 'no actions needed',
  'wrapping up', 'closing out',
  'conversation complete', 'cycle complete',
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
 *
 * Uses explicit STATUS/VERDICT markers from conversation-roles.md:
 * - Lead: `## STATUS: DONE` or `## STATUS: CONTINUE`
 * - Verifier: `## VERDICT: APPROVED` or `## VERDICT: REJECTED`
 * - Any role: `BLOCKED: [reason]`
 *
 * Falls back to keyword detection for agents that don't follow the format.
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

  if (transcript.turns.length === 0) {
    return { converged: false, reason: 'No turns yet' };
  }

  const lastTurn = transcript.turns[transcript.turns.length - 1];
  const content = lastTurn.content;

  // ── Explicit markers (preferred) ──────────────────────────────────

  // Verifier verdict — strongest signal
  if (/## VERDICT:\s*APPROVED/i.test(content)) {
    return { converged: true, reason: 'Verifier approved' };
  }
  if (/## VERDICT:\s*REJECTED/i.test(content)) {
    return { converged: false, reason: 'Verifier rejected — continuing cycle' };
  }

  // Lead status — only from lead turns
  if (lastTurn.role === 'lead') {
    if (/## STATUS:\s*DONE/i.test(content)) {
      return { converged: true, reason: 'Lead signaled completion' };
    }
    if (/## STATUS:\s*CONTINUE/i.test(content)) {
      return { converged: false, reason: 'Lead assigned more work' };
    }
  }

  // Blocked — any role
  if (/BLOCKED:/i.test(content)) {
    return { converged: true, reason: 'Blocked — needs human action' };
  }

  // ── Fallback: keyword detection ───────────────────────────────────
  // For agents that don't follow the STATUS/VERDICT format

  const lower = content.toLowerCase();

  if (lastTurn.role === 'verifier') {
    const rejected = VERIFIER_REJECTION_PHRASES.some(phrase => lower.includes(phrase));
    if (rejected) return { converged: false, reason: 'Verifier rejected (keyword)' };
    const approved = VERIFIER_APPROVAL_PHRASES.some(phrase => lower.includes(phrase));
    if (approved) return { converged: true, reason: 'Verifier approved (keyword)' };
  }

  if (lastTurn.role === 'lead') {
    const leadDone = LEAD_COMPLETION_PHRASES.some(phrase => lower.includes(phrase));
    if (leadDone) return { converged: true, reason: 'Lead signaled completion (keyword)' };
  }

  // Continuation beats convergence
  const hasContinuation = CONTINUATION_PHRASES.some(phrase => lower.includes(phrase));
  if (hasContinuation) return { converged: false, reason: 'Continuation signal detected' };

  const hasConvergence = CONVERGENCE_PHRASES.some(phrase => lower.includes(phrase));
  if (hasConvergence) return { converged: true, reason: 'Convergence signal detected' };

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
