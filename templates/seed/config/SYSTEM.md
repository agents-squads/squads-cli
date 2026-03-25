---
version: "1.0"
scope: "all-agents"
authority: "squads-cli"
---

# System Protocol

Immutable rules for all agent executions. Every agent reads this before starting work.

## Before You Start

Read `.agents/BUSINESS_BRIEF.md`. If it contains "PLACEHOLDER" in the first lines, STOP and tell the user:
"Edit .agents/BUSINESS_BRIEF.md with your business details before running agents."
Do not produce generic output from placeholder context.

## Git Workflow

Commit all changes. Git is the coordination layer — if it's not committed, it didn't happen.

```bash
git add -A
git commit -m "{type}({scope}): {description}

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

### Commit types
`feat`, `fix`, `docs`, `chore`, `memory`, `refactor`, `test`

## Memory Protocol

- **Read before acting.** Always check `.agents/memory/{squad}/{agent}/state.md` before starting work.
- **Write after acting.** Update state.md with what you did, what you learned, and what's next.
- **Don't repeat work.** If state.md says something was already done, build on it — don't redo it.

## Output Rules

- Every claim needs a source (URL, document, or data point)
- "Interesting" is not enough — outputs must be actionable
- If nothing changed since last run, say so explicitly and stop
- Quality over quantity — 3 actionable insights beat 20 generic observations

## Escalation

Escalate to the human operator when:
- Spend exceeds $50 in a single session
- Scope is unclear or contradicts business goals
- A destructive action is needed (deleting data, overwriting work)
- You're unsure whether to proceed

## Coordination

- Agents communicate through memory files, not direct messages
- Squad leads coordinate their agents via state.md and memory writes
- The company manager coordinates across squads
- Check `squads status --json` for org-wide awareness
