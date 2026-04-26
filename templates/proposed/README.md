# Proposed governance changes

Agents cannot edit governance files directly (`goals.md`, `priorities.md`, `directives.md`, `SQUAD.md`). The PreToolUse guardrail blocks those writes.

When an agent believes a governance file should change, it writes a proposal here instead.

## Naming convention

```
.squads/proposed/<source-file>-<YYYYMMDD>-<short-slug>.md
```

Examples:
- `goals-engineering-20260425-add-cross-platform.md`
- `priorities-marketing-20260425-deprioritize-outbound.md`
- `directives-20260425-shift-to-inbound-only.md`

## Proposal format

```markdown
# Proposal: <one-line summary>

**Target file:** `.agents/memory/<squad>/goals.md`
**Source agent:** `<squad>/<agent>`
**Reason:** <why this change is needed — link to data, executions, learnings>

## Proposed change
<exact diff or new content>

## Impact
<what this changes about the squad's behaviour>

## Founder decision
- [ ] Accepted — merged to canonical file on YYYY-MM-DD
- [ ] Rejected — reason: ...
- [ ] Deferred — revisit on YYYY-MM-DD
```

## When proposing `goals.md` changes

Every entry under `Achieved`, `In Progress`, or `Active` **must cite a verifiable ref** — PR, commit, file path, or issue. See `docs/governance.md` for the format spec and examples.

Proposals that add `Achieved` entries with no ref will be rejected on review. The validator (`scripts/validate-goals.sh` in `hq`, `squads coherence` in a future CLI release) catches the same issue automatically.

## Founder workflow

Weekly (or per-release), the founder reviews proposals:

```bash
ls .squads/proposed/                          # see what's queued
squads coherence                              # check for drift before deciding
# review each proposal, decide
# accepted: merge into canonical file, then move proposal to .squads/proposed/accepted/
# rejected: move to .squads/proposed/rejected/ with reason in the file
```

The proposal channel is a **defer**, not a **block** — agents keep contributing ideas, the founder keeps governance authority.
