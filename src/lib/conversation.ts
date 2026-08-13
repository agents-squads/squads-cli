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
  // Substrings (not whole words) so they match compound names + Spanish rosters
  // (e.g. "orquestador", "escáner", "verificador") — see #449.
  const name = agentName.toLowerCase();
  if (name.includes('lead') || name.includes('orchestrator') || name.includes('orquestador') || name.includes('lider') || name.includes('líder')) return 'lead';
  if (name.includes('scanner') || name.includes('scout') || name.includes('monitor') || name.includes('escaner') || name.includes('escáner')) return 'scanner';
  if (name.includes('verifier') || name.includes('critic') || name.includes('reviewer') || name.includes('verificador') || name.includes('crítico') || name.includes('critico')) return 'verifier';
  if (name.includes('worker') || name.includes('solver') || name.includes('builder') || name.includes('trabajador')) return 'worker';

  // Fallback: parse role description from SQUAD.md. Matches English + Spanish
  // synonyms (lead/orquestador/líder, scanner/escáner, verifier/verificador/crítico,
  // worker/trabajador). Substring stems cover conjugations/accents (#449).
  if (roleDescription) {
    const lower = roleDescription.toLowerCase();
    if (lower.includes('orchestrat') || lower.includes('orquestad') || lower.includes('triage') || lower.includes('coordinat') || lower.includes('lead') || lower.includes('lider') || lower.includes('líder')) return 'lead';
    if (lower.includes('scan') || lower.includes('escan') || lower.includes('escán') || lower.includes('monitor') || lower.includes('detect')) return 'scanner';
    if (lower.includes('verif') || lower.includes('critic') || lower.includes('crític') || lower.includes('review') || lower.includes('check')) return 'verifier';
    return 'worker';
  }

  return null; // Unclassified — excluded from conversation
}

/**
 * Detect a quota/limit response from the provider.
 * Live formats observed: "You've hit your limit", "You've hit your session limit ·
 * resets 3:10am" — the `session` variant slips past a bare 'hit your limit'
 * substring check, letting capped turns flow into task parsing (hq#452).
 */
export function isQuotaMessage(text: string): boolean {
  return /hit your (?:\w+ )?limit/i.test(text)
    || /rate.?limit/i.test(text)
    || text.includes('[QUOTA]')
    || text.includes('Quota limit reached');
}

/**
 * Detect an unauthenticated/invalid-credential response from the provider CLI.
 * A missing login or invalid key fails EVERY turn identically — unlike a quota
 * wall, it never clears mid-run, so this must abort the whole conversation
 * loud rather than exhaust turns until "no signals" prints a cryptic stop (#956).
 */
export function isAuthFailureMessage(text: string): boolean {
  return /not logged in|please run \/login|invalid api key/i.test(text);
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

  // If short conversation (≤5 turns or single cycle), return everything
  if (turns.length <= 5 || cycleBoundaries.length <= 1) {
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

  // Always preserve the initial brief (first turn)
  const firstTurn = turns[0];
  lines.push(`**${firstTurn.agent} (${firstTurn.role}):**`);
  lines.push(firstTurn.content);
  lines.push('');

  if (oldTurns.length > 1) {
    lines.push(`*(${oldTurns.length - 1} earlier turns compacted)*\n`);
  }

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

/**
 * NO PHRASE LISTS. Convergence is decided by artifacts (branch, commits, PR +
 * CI), never by matching agent prose — spec convergence-by-artifact-2026-08-13,
 * authority derive-and-gate §Layer 0: an LLM judge is never the gate for a
 * machine-checkable fact. "Did this run finish?" is machine-checkable.
 *
 * The lists that used to live here converged a conversation whenever any turn
 * contained e.g. "tests pass" — including "I need to make sure tests pass
 * before merging" (cli#873: converged with worker-tasks unexecuted, then
 * cleanup destroyed the work). They were also English-only in a Spanish-first
 * market, while role detection above is already bilingual. Do not reintroduce
 * them, in any language: chasing languages with string lists has no end state.
 */

/**
 * `proposed` is the important state: an agent *claimed* it is done. That claim
 * is not authority to stop — the caller must confirm it against artifacts
 * before converging (see checkConvergence in workflow.ts). `blocked` is
 * terminal but is NOT success: the run halted awaiting a human, and it must
 * not be recorded as `completed` (cli#1154).
 */
export type ConvergenceState = 'continue' | 'proposed' | 'converged' | 'blocked';

export interface ConvergenceResult {
  /** Terminal AND successful. `blocked` is terminal but never sets this true. */
  converged: boolean;
  state: ConvergenceState;
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
/**
 * Validation contract (#989): the PLAN phase defines done-ness before any code
 * exists. Extracted verbatim so the verifier checks against the contract, not
 * against its own reading of the diff.
 */
export function extractValidationContract(planOutput: string): string {
  const m = planOutput.match(/##\s*VALIDATION CONTRACT\s*\n([\s\S]*?)(?=\n##\s|\n```|$)/i);
  return m ? m[1].trim() : '';
}

/**
 * Structured handoff (#990): workers report completed/undone/commands+exit
 * codes/issues/procedures before their STATUS line. Parsed so the runtime can
 * flag DONE claims contradicted by the worker's own command log.
 */
export interface ParsedHandoff {
  present: boolean;
  undone: string;
  /** Exit codes found in the commands field (e.g. "`npm test` → 1"). */
  exitCodes: number[];
  /** DONE status contradicted by non-empty undone or a nonzero exit code. */
  contradictsDone: boolean;
}

export function parseHandoff(text: string): ParsedHandoff {
  const block = text.match(/##\s*HANDOFF\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!block) return { present: false, undone: '', exitCodes: [], contradictsDone: false };
  const body = block[1];
  const field = (name: string): string => {
    const m = body.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  const undone = field('undone');
  const commands = field('commands');
  const exitCodes = [...commands.matchAll(/(?:→|->)\s*(\d+)/g)].map(m => parseInt(m[1], 10));
  const claimsDone = /##\s*STATUS:\s*DONE/i.test(text);
  const undoneNonEmpty = undone !== '' && !/^(none|n\/a|-)\.?$/i.test(undone);
  const hasFailingExit = exitCodes.some(c => c !== 0);
  return {
    present: true,
    undone,
    exitCodes,
    contradictsDone: claimsDone && (undoneNonEmpty || hasFailingExit),
  };
}

export function detectConvergence(
  transcript: Transcript,
  maxTurns: number,
  costCeiling: number,
): ConvergenceResult {
  // Hard limits — the only prose-free terminal conditions, and the reason an
  // unrecognised transcript can safely keep going.
  if (transcript.turns.length >= maxTurns) {
    return { converged: true, state: 'converged', reason: `Max turns reached (${maxTurns})` };
  }
  if (transcript.totalCost >= costCeiling) {
    return { converged: true, state: 'converged', reason: `Cost ceiling reached ($${transcript.totalCost.toFixed(2)}/$${costCeiling})` };
  }

  if (transcript.turns.length === 0) {
    return { converged: false, state: 'continue', reason: 'No turns yet' };
  }

  const lastTurn = transcript.turns[transcript.turns.length - 1];
  const content = lastTurn.content;

  // ── Explicit markers ──────────────────────────────────────────────
  // A marker is a CLAIM, not authority to stop. It returns `proposed`; the
  // caller confirms it against artifacts before converging. Markers are
  // literal tokens, so this path is language-neutral by construction.

  // A worker's own handoff can contradict its DONE claim (#990) — undone work
  // listed, or a nonzero exit code in its command log. Never propose on that.
  const handoff = parseHandoff(content);
  if (handoff.contradictsDone) {
    return {
      converged: false,
      state: 'continue',
      reason: `DONE claim contradicted by the agent's own handoff (undone: ${handoff.undone || 'n/a'}, exit codes: ${handoff.exitCodes.join(', ') || 'none'})`,
    };
  }

  // Verifier verdict
  if (/## VERDICT:\s*APPROVED/i.test(content)) {
    return { converged: false, state: 'proposed', reason: 'Verifier approved' };
  }
  if (/## VERDICT:\s*REJECTED/i.test(content)) {
    return { converged: false, state: 'continue', reason: 'Verifier rejected — continuing cycle' };
  }

  // Lead status — only from lead turns
  if (lastTurn.role === 'lead') {
    if (/## STATUS:\s*DONE/i.test(content)) {
      return { converged: false, state: 'proposed', reason: 'Lead signaled completion' };
    }
    if (/## STATUS:\s*CONTINUE/i.test(content)) {
      return { converged: false, state: 'continue', reason: 'Lead assigned more work' };
    }
  }

  // Blocked — any role. Terminal, but NOT success: the run halted awaiting a
  // human. Recording this as `completed` is cli#1154.
  if (/BLOCKED:/i.test(content)) {
    return { converged: false, state: 'blocked', reason: 'Blocked — needs human action' };
  }

  // No marker: keep going. There is deliberately no prose fallback — see the
  // note above the ConvergenceState type. Stopping is the destructive action
  // (it triggers cleanup), so an unrecognised turn continues to the turn/cost
  // ceiling, which are hard limits already enforced at the top.
  return { converged: false, state: 'continue', reason: 'No completion marker, continuing' };
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
