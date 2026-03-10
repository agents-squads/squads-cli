/**
 * Local-first cognition engine.
 *
 * Processes signals → beliefs → reflections locally using JSON files.
 * Pushes to API when available (pro/enterprise feature).
 *
 * The intelligence loop:
 *   1. Ingest: memory files → signals
 *   2. Synthesize: classify signals against beliefs (Haiku)
 *   3. Evaluate: score past decisions
 *   4. Reflect: meta-cognition assessment (Sonnet, every 4h)
 *   5. Push: sync to API if reachable
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { findMemoryDir } from './memory.js';
import { pushCognitionSignal, ingestMemorySignal } from './api-client.js';
import { slackNotify } from './squad-loop.js';
import { colors, RESET, writeLine } from './terminal.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CognitionSignal {
  id: number;
  source: string;       // execution, memory, financial, market, etc.
  signal_type: string;
  value: number | null;
  unit: string | null;
  data: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
  confidence: number;
  created_at: string;
}

export interface CognitionBelief {
  belief_key: string;
  domain: string;       // revenue, product, operations, market, team
  statement: string;
  confidence: number;   // 0.0 - 1.0
  supporting_signals: number[];   // signal IDs
  contradicting_signals: number[];
  temperature: 'hot' | 'warm' | 'cold';
  revision: number;
  updated_at: string;
}

export interface CognitionDecision {
  id: number;
  title: string;
  context: Record<string, unknown>;
  reasoning: string;
  action_taken: string;
  expected_outcome: Record<string, unknown>;
  decided_by: string;
  decided_at: string;
  outcome_score: number | null;   // -1.0 to 1.0
  actual_outcome: Record<string, unknown> | null;
}

export interface CognitionReflection {
  id: number;
  scope: string;
  assessment: string;
  insights: Array<{ type: string; message: string }>;
  belief_updates: Array<{ belief_key: string; suggested_confidence: number; reason: string }>;
  priority_adjustments: Array<{ description: string; urgency: string }>;
  founder_escalations: Array<{ issue: string; why_human_needed: string; suggested_action: string; urgency: string }>;
  created_at: string;
}

export interface CognitionState {
  signals: CognitionSignal[];
  beliefs: CognitionBelief[];
  decisions: CognitionDecision[];
  reflections: CognitionReflection[];
  last_synthesize: string | null;
  last_reflect: string | null;
  next_signal_id: number;
  next_decision_id: number;
  next_reflection_id: number;
  memory_hashes: Record<string, string>;
}

// ── Constants ────────────────────────────────────────────────────────

const COGNITION_DIR_NAME = 'cognition';
const STATE_FILE = 'state.json';
const SYNTHESIZE_INTERVAL_MS = 30 * 60 * 1000;  // 30 min
const REFLECT_INTERVAL_MS = 4 * 60 * 60 * 1000;  // 4 hours
const MAX_SIGNALS_KEPT = 500;
const MAX_REFLECTIONS_KEPT = 50;
const CONFIDENCE_PRIOR_WEIGHT = 0.7;
const CONFIDENCE_EVIDENCE_WEIGHT = 0.3;
const CONFIDENCE_MIN = 0.05;
const CONFIDENCE_MAX = 0.95;
const BELIEF_SHIFT_THRESHOLD = 0.15;  // Slack notify on 15%+ shift
const MAX_SUPPORTING_IDS = 20;

const INGESTIBLE_FILES = ['state', 'learnings', 'executions'] as const;

const FILE_TYPE_MAPPING: Record<string, { source: string; signal_type: string }> = {
  state: { source: 'memory', signal_type: 'state_update' },
  learnings: { source: 'memory', signal_type: 'learning' },
  executions: { source: 'execution', signal_type: 'execution_log' },
  events: { source: 'market', signal_type: 'external_event' },
  directives: { source: 'execution', signal_type: 'directive' },
};

// ── Storage ──────────────────────────────────────────────────────────

/**
 * Call Claude CLI with a prompt via stdin.
 * Strips CLAUDECODE env var to avoid nested session errors.
 */
function callClaude(prompt: string, model: string, timeoutMs: number): string | null {
  const { CLAUDECODE: _, ANTHROPIC_API_KEY: _k, ...cleanEnv } = process.env;
  const result = spawnSync('claude', ['--print', '--model', model], {
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}

function getCognitionDir(): string {
  const memDir = findMemoryDir();
  const dir = memDir
    ? join(memDir, COGNITION_DIR_NAME)
    : join(process.cwd(), '.agents', 'memory', COGNITION_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultState(): CognitionState {
  return {
    signals: [],
    beliefs: [],
    decisions: [],
    reflections: [],
    last_synthesize: null,
    last_reflect: null,
    next_signal_id: 1,
    next_decision_id: 1,
    next_reflection_id: 1,
    memory_hashes: {},
  };
}

export function loadCognitionState(): CognitionState {
  const dir = getCognitionDir();
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return defaultState();
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CognitionState;
  } catch {
    return defaultState();
  }
}

export function saveCognitionState(state: CognitionState): void {
  const dir = getCognitionDir();
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

// ── Signal Ingestion ─────────────────────────────────────────────────

/**
 * Add a signal to the local cognition state.
 * Also pushes to API if available.
 */
export function addSignal(
  state: CognitionState,
  signal: Omit<CognitionSignal, 'id' | 'created_at'>,
): CognitionSignal {
  const newSignal: CognitionSignal = {
    ...signal,
    id: state.next_signal_id++,
    created_at: new Date().toISOString(),
  };
  state.signals.push(newSignal);

  // Trim old signals
  if (state.signals.length > MAX_SIGNALS_KEPT) {
    state.signals = state.signals.slice(-MAX_SIGNALS_KEPT);
  }

  // Push to API (fire-and-forget)
  pushCognitionSignal({
    source: signal.source,
    signal_type: signal.signal_type,
    value: signal.value ?? undefined,
    unit: signal.unit ?? undefined,
    data: signal.data,
    entity_type: signal.entity_type ?? undefined,
    entity_id: signal.entity_id ?? undefined,
    confidence: signal.confidence,
  });

  return newSignal;
}

/**
 * Ingest memory files from agent runs into signals.
 * Reads .agents/memory/{squad}/{agent}/{state,learnings,executions}.md
 * Deduplicates by content hash.
 */
export function ingestMemoryFiles(
  state: CognitionState,
  squads: string[],
  verbose: boolean = false,
): number {
  const memDir = findMemoryDir();
  if (!memDir) return 0;

  let signalsCreated = 0;

  for (const squad of squads) {
    const squadPath = join(memDir, squad);
    if (!existsSync(squadPath)) continue;

    let agents: string[];
    try {
      agents = readdirSync(squadPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== COGNITION_DIR_NAME)
        .map(e => e.name);
    } catch { continue; }

    for (const agent of agents) {
      for (const fileType of INGESTIBLE_FILES) {
        const filePath = join(squadPath, agent, `${fileType}.md`);
        if (!existsSync(filePath)) continue;

        let content: string;
        try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
        if (!content.trim()) continue;

        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        const key = `${squad}/${agent}/${fileType}`;

        if (state.memory_hashes[key] === hash) continue;
        state.memory_hashes[key] = hash;

        // Extract bullet points as individual signals
        const mapping = FILE_TYPE_MAPPING[fileType] || FILE_TYPE_MAPPING.state;
        const bullets = content
          .split('\n')
          .filter(line => line.trim().startsWith('- ') || line.trim().startsWith('* '))
          .map(line => line.trim().replace(/^[-*]\s+/, ''))
          .filter(line => line.length > 10);

        if (bullets.length === 0) {
          // Whole file as single signal
          addSignal(state, {
            source: mapping.source,
            signal_type: mapping.signal_type,
            value: null,
            unit: null,
            data: { content: content.slice(0, 500), content_hash: hash },
            entity_type: 'memory_file',
            entity_id: key,
            confidence: 0.8,
          });
          signalsCreated++;
        } else {
          // Each bullet as a signal
          for (const bullet of bullets.slice(0, 10)) {
            addSignal(state, {
              source: mapping.source,
              signal_type: mapping.signal_type,
              value: null,
              unit: null,
              data: { content: bullet, file: key, content_hash: hash },
              entity_type: 'memory_file',
              entity_id: key,
              confidence: 0.8,
            });
            signalsCreated++;
          }
        }

        // Also push to API
        ingestMemorySignal({ squad, agent, file_type: fileType, content, content_hash: hash });

        if (verbose) {
          writeLine(`    ${colors.dim}Cognition: ${key} → ${bullets.length || 1} signals${RESET}`);
        }
      }
    }
  }

  return signalsCreated;
}

// ── Belief Synthesis ─────────────────────────────────────────────────

/**
 * Classify recent signals against beliefs using Claude Haiku.
 * Updates belief confidence using Bayesian-ish formula.
 */
export async function synthesizeSignals(
  state: CognitionState,
  verbose: boolean = false,
): Promise<number> {
  if (state.beliefs.length === 0) return 0;

  // Only process signals since last synthesis
  const cutoff = state.last_synthesize
    ? new Date(state.last_synthesize).getTime()
    : 0;
  const recentSignals = state.signals.filter(
    s => new Date(s.created_at).getTime() > cutoff,
  );

  if (recentSignals.length === 0) return 0;

  let beliefsUpdated = 0;

  for (const belief of state.beliefs) {
    // Build classification prompt
    const signalList = recentSignals
      .map((s, i) => `${i + 1}. [${s.source}] ${s.signal_type}${s.value !== null ? ' = ' + s.value : ''}${s.unit ? ' ' + s.unit : ''}: ${(s.data.content as string || '').slice(0, 100)}`)
      .join('\n');

    const prompt = `Given this belief: "${belief.statement}"

Classify each signal as SUPPORTING or CONTRADICTING or NEUTRAL.

Signals:
${signalList}

Respond with JSON only: {"supporting": [indexes], "contradicting": [indexes], "neutral": [indexes]}`;

    try {
      // Call Haiku via claude CLI (uses subscription, no API key needed)
      const result = callClaude(prompt, 'haiku', 30000);
      if (!result) continue;

      // Parse JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const classification = JSON.parse(jsonMatch[0]) as {
        supporting?: number[];
        contradicting?: number[];
      };

      const supportingCount = classification.supporting?.length || 0;
      const contradictingCount = classification.contradicting?.length || 0;

      if (supportingCount + contradictingCount === 0) continue;

      // Map indexes to signal IDs
      const supportingIds = (classification.supporting || [])
        .map(i => recentSignals[i - 1]?.id)
        .filter((id): id is number => id !== undefined);
      const contradictingIds = (classification.contradicting || [])
        .map(i => recentSignals[i - 1]?.id)
        .filter((id): id is number => id !== undefined);

      // Bayesian confidence update
      const oldConfidence = belief.confidence;
      const evidenceRatio = supportingCount / (supportingCount + contradictingCount);
      let newConfidence = oldConfidence * CONFIDENCE_PRIOR_WEIGHT + evidenceRatio * CONFIDENCE_EVIDENCE_WEIGHT;
      newConfidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, newConfidence));

      // Update belief
      belief.confidence = newConfidence;
      belief.supporting_signals = [...belief.supporting_signals, ...supportingIds].slice(-MAX_SUPPORTING_IDS);
      belief.contradicting_signals = [...belief.contradicting_signals, ...contradictingIds].slice(-MAX_SUPPORTING_IDS);
      belief.revision++;
      belief.updated_at = new Date().toISOString();
      belief.temperature = 'hot';
      beliefsUpdated++;

      // Notify on significant shifts
      const shift = Math.abs(newConfidence - oldConfidence);
      if (shift >= BELIEF_SHIFT_THRESHOLD) {
        const direction = newConfidence > oldConfidence ? '↑' : '↓';
        slackNotify(
          `*Belief shift* ${direction} ${belief.belief_key}: ${(oldConfidence * 100).toFixed(0)}% → ${(newConfidence * 100).toFixed(0)}%\n${belief.statement}`,
        );
      }

      if (verbose) {
        writeLine(`    ${colors.dim}Belief: ${belief.belief_key} ${(oldConfidence * 100).toFixed(0)}% → ${(newConfidence * 100).toFixed(0)}% (+${supportingCount}/-${contradictingCount})${RESET}`);
      }
    } catch {
      // Haiku call failed — skip this belief, try next
      continue;
    }
  }

  state.last_synthesize = new Date().toISOString();
  return beliefsUpdated;
}

// ── Decision Evaluation ──────────────────────────────────────────────

/**
 * Auto-evaluate decisions older than 2h by counting execution signals.
 */
export function evaluateDecisions(state: CognitionState): number {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  let evaluated = 0;

  for (const decision of state.decisions) {
    if (decision.outcome_score !== null) continue;
    if (new Date(decision.decided_at).getTime() > twoHoursAgo) continue;

    // Count positive/negative signals after decision
    const decisionTime = new Date(decision.decided_at).getTime();
    const relevantSignals = state.signals.filter(
      s => new Date(s.created_at).getTime() > decisionTime,
    );

    const completed = relevantSignals.filter(s =>
      s.signal_type === 'agent_completed' || s.signal_type === 'conversation_converged',
    ).length;
    const failed = relevantSignals.filter(s =>
      s.signal_type === 'agent_failed' || s.signal_type === 'conversation_stopped',
    ).length;

    if (completed + failed < 3) continue;

    decision.outcome_score = (completed / (completed + failed)) * 2 - 1;
    decision.actual_outcome = { completed, failed, total: completed + failed };
    evaluated++;
  }

  return evaluated;
}

// ── Reflection ───────────────────────────────────────────────────────

/**
 * Periodic meta-cognition using Sonnet.
 * Produces insights, belief updates, founder escalations.
 */
export async function reflect(
  state: CognitionState,
  verbose: boolean = false,
): Promise<CognitionReflection | null> {
  // Check if enough time has passed
  if (state.last_reflect) {
    const elapsed = Date.now() - new Date(state.last_reflect).getTime();
    if (elapsed < REFLECT_INTERVAL_MS) return null;
  }

  // Skip if no new signals since last reflection
  const lastReflectTime = state.last_reflect ? new Date(state.last_reflect).getTime() : 0;
  const newSignals = state.signals.filter(s => new Date(s.created_at).getTime() > lastReflectTime);
  if (newSignals.length === 0) return null;

  // Build context
  const beliefsText = state.beliefs
    .map(b => `- [${b.domain}] ${b.belief_key} (${(b.confidence * 100).toFixed(0)}%, ${b.temperature}, r${b.revision}): ${b.statement}`)
    .join('\n');

  const signalsText = newSignals.slice(-30)
    .map(s => `- [${s.source}] ${s.signal_type}: ${(s.data.content as string || '').slice(0, 80)} (${new Date(s.created_at).toLocaleTimeString()})`)
    .join('\n');

  const decisionsText = state.decisions
    .map(d => `- ${d.title} (score: ${d.outcome_score !== null ? d.outcome_score.toFixed(2) : 'pending'})`)
    .join('\n');

  const lastReflection = state.reflections.length > 0
    ? state.reflections[state.reflections.length - 1]
    : null;

  const prompt = `You are the cognition engine for an AI-native company called Agents Squads.
Your job is to reflect on the current state of the business and produce actionable insights.

## Current Beliefs (world model)
${beliefsText || '(none)'}

## Recent Signals (since last reflection)
${signalsText || '(none)'}

## Decision Journal
${decisionsText || '(none)'}

${lastReflection ? `Previous reflection (${lastReflection.created_at}):\n${lastReflection.assessment}\n` : ''}

## Your Task
Produce a business reflection. Respond as JSON only:
{
  "assessment": "2-3 sentence summary of business state",
  "insights": [{"type": "highlight|warning|recommendation", "message": "..."}],
  "belief_updates": [{"belief_key": "...", "suggested_confidence": 0.X, "reason": "..."}],
  "priority_adjustments": [{"description": "...", "urgency": "high|medium|low"}],
  "founder_escalations": [{"issue": "...", "why_human_needed": "...", "suggested_action": "...", "urgency": "immediate|today|this_week"}]
}`;

  try {
    const result = callClaude(prompt, 'sonnet', 60000);
    if (!result) return null;

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    const reflection: CognitionReflection = {
      id: state.next_reflection_id++,
      scope: 'business',
      assessment: parsed.assessment || '',
      insights: parsed.insights || [],
      belief_updates: parsed.belief_updates || [],
      priority_adjustments: parsed.priority_adjustments || [],
      founder_escalations: parsed.founder_escalations || [],
      created_at: new Date().toISOString(),
    };

    state.reflections.push(reflection);
    if (state.reflections.length > MAX_REFLECTIONS_KEPT) {
      state.reflections = state.reflections.slice(-MAX_REFLECTIONS_KEPT);
    }

    // Apply belief updates
    for (const update of reflection.belief_updates) {
      const belief = state.beliefs.find(b => b.belief_key === update.belief_key);
      if (belief && update.suggested_confidence >= 0 && update.suggested_confidence <= 1) {
        belief.confidence = update.suggested_confidence;
        belief.revision++;
        belief.updated_at = new Date().toISOString();
        belief.temperature = 'hot';
      }
    }

    // Notify founder on escalations
    if (reflection.founder_escalations.length > 0) {
      const escalationText = reflection.founder_escalations
        .map(e => `• *${e.issue}*: ${e.suggested_action} (${e.urgency})`)
        .join('\n');
      slackNotify(`🧠 *Cognition reflection*\n${reflection.assessment}\n\n*Escalations:*\n${escalationText}`);
    } else if (verbose) {
      slackNotify(`🧠 *Cognition reflection*\n${reflection.assessment}`);
    }

    state.last_reflect = new Date().toISOString();

    if (verbose) {
      writeLine(`    ${colors.dim}Reflection: ${reflection.insights.length} insights, ${reflection.belief_updates.length} belief updates, ${reflection.founder_escalations.length} escalations${RESET}`);
    }

    return reflection;
  } catch {
    return null;
  }
}

// ── Temperature Update ───────────────────────────────────────────────

export function updateBeliefTemperatures(state: CognitionState): void {
  const now = Date.now();
  for (const belief of state.beliefs) {
    const age = now - new Date(belief.updated_at).getTime();
    if (age < 4 * 60 * 60 * 1000) {
      belief.temperature = 'hot';
    } else if (age < 24 * 60 * 60 * 1000) {
      belief.temperature = 'warm';
    } else {
      belief.temperature = 'cold';
    }
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Run the full cognition cycle. Called after agent execution in squads run.
 *
 * 1. Ingest memory files → local signals (+ push to API)
 * 2. Synthesize signals against beliefs (Haiku)
 * 3. Evaluate past decisions
 * 4. Reflect if enough time has passed (Sonnet)
 * 5. Update temperatures
 * 6. Save state
 */
export async function runCognitionCycle(
  squads: string[],
  verbose: boolean = false,
): Promise<{
  signalsIngested: number;
  beliefsUpdated: number;
  decisionsEvaluated: number;
  reflected: boolean;
}> {
  const state = loadCognitionState();

  // 1. Ingest memory files
  const signalsIngested = ingestMemoryFiles(state, squads, verbose);

  // 2. Synthesize (if enough time passed)
  let beliefsUpdated = 0;
  const timeSinceSynthesize = state.last_synthesize
    ? Date.now() - new Date(state.last_synthesize).getTime()
    : Infinity;
  if (timeSinceSynthesize >= SYNTHESIZE_INTERVAL_MS && state.signals.length > 0) {
    beliefsUpdated = await synthesizeSignals(state, verbose);
  }

  // 3. Evaluate decisions
  const decisionsEvaluated = evaluateDecisions(state);

  // 4. Reflect (if enough time passed)
  const reflection = await reflect(state, verbose);

  // 5. Update temperatures
  updateBeliefTemperatures(state);

  // 6. Save
  saveCognitionState(state);

  if (verbose || signalsIngested > 0 || beliefsUpdated > 0 || reflection) {
    writeLine(`  ${colors.dim}Cognition: ${signalsIngested} signals, ${beliefsUpdated} beliefs updated${reflection ? ', reflected' : ''}${RESET}`);
  }

  return {
    signalsIngested,
    beliefsUpdated,
    decisionsEvaluated,
    reflected: !!reflection,
  };
}

/**
 * Seed initial beliefs if none exist.
 * Called once on first run to bootstrap the world model.
 */
export function seedBeliefsIfEmpty(state: CognitionState): void {
  if (state.beliefs.length > 0) return;

  const seeds: Array<Omit<CognitionBelief, 'supporting_signals' | 'contradicting_signals' | 'temperature' | 'revision' | 'updated_at'>> = [
    { belief_key: 'retention_critical', domain: 'product', statement: 'D1 retention (10%) is the primary blocker to product-market fit. Must reach 30% before monetizing.', confidence: 0.9 },
    { belief_key: 'cli_is_os', domain: 'product', statement: 'The CLI is our operating system. Every improvement multiplies autonomous capability.', confidence: 0.85 },
    { belief_key: 'zero_revenue', domain: 'revenue', statement: 'Revenue is $0. Consulting is the near-term path. Pro tier gated on retention.', confidence: 0.95 },
    { belief_key: 'agent_autonomy_low', domain: 'operations', statement: 'Agents run but do not think autonomously. Scanners and leads never fire. Intelligence loop is broken.', confidence: 0.8 },
    { belief_key: 'first_run_broken', domain: 'product', statement: 'First-run experience is broken. v0.7.0 crashes on squads run. Users cannot complete the core flow.', confidence: 0.9 },
    { belief_key: 'global_developer_focus', domain: 'market', statement: 'Target market is global developers, not Chilean enterprises. Product-first, not consulting-first.', confidence: 0.75 },
    { belief_key: 'test_user_simulation', domain: 'operations', statement: 'Simulating test users (fresh install → init → run → evaluate friction) is the most effective way to find and fix retention blockers.', confidence: 0.7 },
    { belief_key: 'cognition_engine_needed', domain: 'operations', statement: 'Without a working cognition engine, the organization cannot learn or improve autonomously. This is the difference between a cron job and intelligence.', confidence: 0.85 },
  ];

  const now = new Date().toISOString();
  for (const seed of seeds) {
    state.beliefs.push({
      ...seed,
      supporting_signals: [],
      contradicting_signals: [],
      temperature: 'warm',
      revision: 1,
      updated_at: now,
    });
  }
}

/**
 * Get beliefs formatted as markdown for agent context injection.
 */
export function getBeliefsContext(state: CognitionState): string {
  const hotBeliefs = state.beliefs.filter(b => b.temperature === 'hot' || b.temperature === 'warm');
  if (hotBeliefs.length === 0) return '';

  const lines = hotBeliefs.map(b =>
    `- **${b.belief_key}** (${(b.confidence * 100).toFixed(0)}%): ${b.statement}`,
  );

  return `## Organizational Beliefs (from cognition engine)\n${lines.join('\n')}\n`;
}
