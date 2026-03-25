# Squad Conversation Protocol

## What It Is

The conversation protocol is how squads collaborate. Instead of agents running independently (old `--parallel` mode), agents share a transcript and take turns — like a real team meeting.

```
Lead briefs → Scanners discover → Workers execute → Lead iterates → Verifier checks → Done
```

The CLI manages who speaks when. The lead manages what they work on.

## Why It Exists

**Old way (`--parallel`):** All agents run simultaneously, no coordination. Fast but no quality convergence. Marketing squad's content writer doesn't know what the scanner found. Workers duplicate effort or miss context.

**New way (conversation protocol):** Agents build on each other's work. Scanner finds 3 issues → lead prioritizes #1 → worker fixes #1 → lead reviews → verifier confirms. One coherent conversation, not 5 independent ones.

## How It Works

### The Flow

```
Turn 1: LEAD briefs the squad
  ├─ Reads squad goals, sprint issues, previous state
  ├─ Produces a plan: "Today we focus on X, Y, Z"
  └─ Sets context for all subsequent agents

Turn 2-3: SCANNERS discover
  ├─ Read lead's brief + squad state
  ├─ Check external data (APIs, databases, file system)
  └─ Report findings: issues, anomalies, opportunities

Turn 4-N: WORKERS execute
  ├─ Read full transcript (lead brief + scanner findings)
  ├─ Execute on lead's priorities informed by scanner data
  ├─ Produce deliverables: PRs, reports, fixes, content
  └─ Signal progress in output

Turn N+1: LEAD iterates (optional)
  ├─ Reviews worker output in transcript
  ├─ Provides feedback or redirects
  └─ Signals convergence or requests another round

Turn N+2: VERIFIER checks (optional)
  ├─ Reviews final deliverables against goals
  ├─ Checks quality: citations, accuracy, completeness
  └─ Flags issues or approves
```

### Shared Transcript

All agents read the same conversation history. When the worker runs, it sees:
1. The lead's brief
2. The scanner's findings
3. Any previous worker outputs

This means workers don't duplicate scanner work, and verifiers see the full chain of reasoning.

### Agent Classification

The CLI automatically classifies agents by their name to determine model and turn order:

| Name Pattern | Role | Model | Turn Order |
|-------------|------|-------|------------|
| `*-lead`, `*-orchestrator` | Lead | Sonnet | First |
| `*-scanner`, `*-scout`, `*-monitor` | Scanner | Haiku | After lead |
| `*-worker`, `*-researcher`, `*-writer`, `*-analyst`, `*-solver` | Worker | Sonnet | After scanners |
| `*-verifier`, `*-critic`, `*-eval`, `*-reviewer` | Verifier | Haiku | Last |

Unclassified agents are excluded from the conversation but can still be run directly with `-a`.

### Convergence

The lead decides when work is done. The CLI watches for convergence signals in the lead's output:

**Continuation signals** (keep going):
- "needs more work", "iterate", "not yet", "try again"

**Convergence signals** (stop):
- "looks good", "approved", "done", "ship it", "converged"

Continuation signals override convergence signals. The lead is conservative — it keeps iterating until quality is met.

### Cost Control

- Default ceiling: $25 per conversation (estimated via turn count x model cost)
- Max turns: 20 (prevents runaway conversations)
- These are ceilings, not targets — most conversations converge in 5-8 turns

## CLI Usage

```bash
# Default: conversation protocol (lead → scanners → workers → verifier)
squads run marketing

# Override: run all agents in parallel (old behavior)
squads run marketing --parallel

# Override: run lead mode (lead spawns workers via Task tool)
squads run marketing --lead

# Direct agent dispatch (bypasses conversation)
squads run marketing -a content-worker

# Override lead's brief with a specific task
squads run marketing --task "Write a blog post about mining AI optimization"
```

## Squad Compatibility

11/18 squads support conversation protocol today:

| Squad | Lead | Scanners | Workers | Verifiers | Ready |
|-------|------|----------|---------|-----------|-------|
| analytics | analytics-lead | analytics-scanner | analytics-worker | analytics-verifier | Yes |
| company | company-lead | — | — | — | Partial |
| customer | customer-lead | customer-scanner | customer-worker | customer-verifier | Yes |
| data | data-lead | data-scanner | data-worker | data-verifier | Yes |
| finance | finance-lead | finance-scanner | finance-worker | finance-verifier | Yes |
| growth | growth-lead | growth-scanner | growth-worker | growth-verifier | Yes |
| marketing | marketing-lead | content-scanner | content-worker | content-verifier | Yes |
| operations | operations-lead | ops-scanner | ops-worker | ops-verifier | Yes |
| product | product-lead | product-scanner | — | — | Partial |
| research | research-lead | research-scanner | research-worker | research-verifier | Yes |
| website | website-lead | site-scanner | site-worker | site-verifier | Yes |

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| Plan document | Approved | `memory/conversation-protocol-plan.md` |
| Lead orchestrator (event-based) | Implemented | `squads-cli/src/lib/orchestration/lead-orchestrator.ts` |
| Orchestrate command | Implemented | `squads-cli/src/commands/orchestrate.ts` |
| `--lead` flag in run.ts | Implemented | `squads-cli/src/commands/run.ts` |
| Shared transcript (conversation.ts) | NOT BUILT | Planned: `squads-cli/src/lib/conversation.ts` |
| Workflow engine (workflow.ts) | NOT BUILT | Planned: `squads-cli/src/lib/workflow.ts` |
| Convergence detection | NOT BUILT | Planned in conversation.ts |
| Agent classification | NOT BUILT | Planned in workflow.ts |
| `--task` override | NOT BUILT | Planned in run.ts |

**Summary: The orchestration infrastructure is ~40% done. The conversation protocol itself (transcript sharing, classification, convergence) is 0% implemented.** The plan is approved and detailed — ready for the CLI squad to build.

## Design Principles

1. **CLI manages turns, lead manages content.** The CLI decides who speaks when (deterministic). The lead decides what they work on (creative).

2. **Shared context, not shared state.** Agents share a transcript (read-only append log), not mutable state. No race conditions.

3. **Convergence over iteration count.** Don't run 20 turns because you can. Stop when the lead says it's good.

4. **Cost routing by role.** Scanners and verifiers use Haiku (cheap, read-heavy). Workers and leads use Sonnet (expensive, creative). This is automatic.

5. **Graceful fallback.** If conversation protocol fails, agents can still run via `--parallel` or `-a direct`.
