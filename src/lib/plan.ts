/**
 * Anthropic plan detection
 * Determines whether the user is on a Max (flat-fee) or Usage (pay-per-token) plan.
 */

/**
 * Anthropic plan types:
 * - 'max': Flat fee subscription ($200/mo), no overage - only rate limits matter
 * - 'usage': Pay-per-token, budget tracking matters
 * - 'unknown': Not configured yet
 */
export type PlanType = 'max' | 'usage' | 'unknown';

/**
 * Plan detection result with confidence and reason
 */
export interface PlanDetection {
  plan: PlanType;
  confidence: 'explicit' | 'inferred';
  reason: string;
}

/**
 * Detect the Anthropic plan type using multiple signals:
 *
 * Priority order:
 * 1. Explicit SQUADS_PLAN_TYPE env var (highest confidence)
 * 2. ANTHROPIC_BUDGET_DAILY set → usage plan (user cares about budget)
 * 3. Tier 4 + no budget → likely Max plan (heavy user)
 * 4. Low tier (1-2) → usage plan (new user, pay-as-you-go)
 * 5. Default: max (assumes professional use)
 */
export function detectPlan(): PlanDetection {
  // 1. Explicit configuration (highest priority)
  const explicitPlan = process.env.SQUADS_PLAN_TYPE?.toLowerCase();
  if (explicitPlan === 'usage') {
    return { plan: 'usage', confidence: 'explicit', reason: 'SQUADS_PLAN_TYPE=usage' };
  }
  if (explicitPlan === 'max') {
    return { plan: 'max', confidence: 'explicit', reason: 'SQUADS_PLAN_TYPE=max' };
  }

  // 2. Budget explicitly set → user cares about costs → usage plan
  const budgetSet = process.env.ANTHROPIC_BUDGET_DAILY || process.env.SQUADS_DAILY_BUDGET;
  if (budgetSet) {
    return { plan: 'usage', confidence: 'inferred', reason: `Budget set ($${budgetSet}/day)` };
  }

  // 3. Check tier - Tier 4 usually indicates Max plan user
  const tier = parseInt(process.env.ANTHROPIC_TIER || '0', 10);
  if (tier >= 4) {
    return { plan: 'max', confidence: 'inferred', reason: `Tier ${tier} (high usage)` };
  }

  // 4. Low tier (1-2) → likely new user on usage plan
  if (tier >= 1 && tier <= 2) {
    return { plan: 'usage', confidence: 'inferred', reason: `Tier ${tier} (new user)` };
  }

  // 5. No API key = OAuth (Claude Code subscription) → treat as Max plan
  // Users authenticated via OAuth have a flat subscription and don't need cost tracking.
  if (!process.env.ANTHROPIC_API_KEY) {
    return { plan: 'max', confidence: 'inferred', reason: 'OAuth (Claude Code subscription)' };
  }

  // 6. API key set but no other signals → usage plan (pay-per-token)
  return { plan: 'usage', confidence: 'inferred', reason: 'API key (pay-per-token)' };
}

/**
 * Get the current Anthropic plan type
 * Use detectPlan() for full details including confidence
 */
export function getPlanType(): PlanType {
  return detectPlan().plan;
}

/**
 * Check if we're on a flat-fee plan where budget doesn't matter
 */
export function isMaxPlan(): boolean {
  return getPlanType() === 'max';
}

/**
 * Get human-readable plan description for dashboard display
 */
export function getPlanDescription(): string {
  const detection = detectPlan();
  const planName = detection.plan === 'max'
    ? 'Max ($200 flat)'
    : detection.plan === 'usage'
      ? 'Usage (pay-per-token)'
      : 'Unknown';
  const confidence = detection.confidence === 'explicit' ? '' : ` [${detection.reason}]`;
  return `${planName}${confidence}`;
}
