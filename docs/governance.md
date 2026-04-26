# Squad governance model

Squads are autonomous within bounds. Governance files set those bounds — and the founder owns them.

## Authority by file

| File | Owner | Updated by | Frequency |
|------|-------|-----------|-----------|
| `directives.md` | Founder + Cofounder | Founder | When strategy shifts |
| `goals.md` (per squad) | Founder + Cofounder | Founder | Per release / quarter |
| `priorities.md` (per squad) | Founder + Cofounder | Founder | Weekly review |
| `SQUAD.md` | Founder | Founder | Rarely (atemporal identity) |
| `state.md` | Squad agents | Workers + lead | Every run |
| `learnings/` | Squad agents | Workers | Every run |
| GitHub issues (tasks) | COO + agents | Anyone | Continuously |

## Why the split

Governance files set the **target**. Memory files capture the **trajectory**. If agents could rewrite both, they'd drift away from the founder's intent run by run — and fast. Letting agents write memory but not governance is the minimum viable separation.

## How it's enforced

The bundled `templates/guardrail.json` includes a PreToolUse hook that blocks `Edit`, `Write`, and `MultiEdit` to:
- `**/goals.md`
- `**/priorities.md`
- `**/directives.md`
- `**/SQUAD.md`

When an agent tries to write one of these, the hook exits with code 2 and a message redirecting to `.squads/proposed/`.

The founder's own Claude Code sessions don't pass through the agent guardrail, so direct edits work normally for governance owners.

## How agents propose changes

Instead of editing the canonical file, agents write to `.squads/proposed/<source-file>-<date>-<slug>.md`. See `.squads/proposed/README.md` for the format.

The founder reviews proposals on a cadence (weekly, or per release) and merges accepted ones into the canonical files.

## `goals.md` format — every claim must cite evidence

Every entry under `Achieved`, `In Progress`, or `Active` in `goals.md` **must** include at least one verifiable reference. Without this, agents can claim wins that didn't happen, and reviewers can't tell convention from fabrication. (Empirical: a one-shot audit across 19 squads found 3 outright false achievements and 66 entries with no checkable reference.)

### Required ref types
At least one of:
- **Pull request:** `→ #123` (same repo) or `→ org/repo#123`
- **Commit:** `→ <sha>` (7+ chars) or `→ org/repo@<sha>`
- **File:** `→ path/to/file.ts:42` (line number optional)
- **Issue closed by PR:** `→ closes #123` or `→ fixed in #456`

### Examples
```markdown
## Achieved
- Conversation protocol shipped → #733
- Telemetry restored after March outage → #739, src/lib/telemetry.ts
- v0.3.1 published to @latest → 2383ab2

## In Progress
- Windows smoke test → #761 (open)
- Governance guardrail → #765 (open)

## Active
- Tier 2 public images → epic #762 (no work started)
```

### Anti-patterns (will be flagged by `squads coherence`)
```markdown
- 13/13 Docker tests pass                    # ❌ no PR/commit/file
- Marketing pipeline working                  # ❌ unverifiable claim
- Achieved telemetry coverage                 # ❌ what proves it?
```

### Validation
Two layers:
1. **Convention** — agents writing proposals to `.squads/proposed/` follow this format.
2. **Tooling** — `squads coherence` (next release) walks every `goals.md`, checks each ref against git/gh state, flags contradictions. Until then, `scripts/validate-goals.sh` in `hq` does the same job.

## Coherence checks

Run `squads coherence` (coming in the next release) to surface drift:
- Are squad goals aligned with `directives.md`?
- Are priorities grounded in goals?
- Are governance files stale (>14 days)?
- Are there pending proposals awaiting founder review?
- Do `Achieved` entries cite verifiable refs (PR, commit, file)?

## Override

In emergencies (security incident, broken release) the founder can edit governance files without going through proposals. There's no audit trail beyond git history — keep that as the source of truth.
