# Squad governance

Squads are autonomous within bounds. Governance files set those bounds — and **only a human in an interactive session sets them.** Autonomous agents execute against those bounds; they cannot rewrite them.

## Authority by file

| File | Set by | Written by autonomous agents? |
|------|--------|-------------------------------|
| `directives.md` | Founder (+ cofounder, in session) | ❌ blocked |
| `goals.md` (per squad) | Founder (+ cofounder, in session) | ❌ blocked |
| `priorities.md` (per squad) | Founder (+ cofounder, in session) | ❌ blocked |
| `SQUAD.md` (atemporal identity) | Founder | ❌ blocked |
| `state.md`, `learnings/` | Squad agents | ✅ allowed (this is their job) |

Governance files set the **target**; memory files capture the **trajectory**. If agents could rewrite both, they'd drift from the founder's intent run by run. Letting agents write memory but not governance is the minimum viable separation.

## How it's enforced

`squads run` (and the daemon) launch each agent with `--settings templates/guardrail.json`, which carries native Claude Code `permissions.deny` rules for `Edit`/`Write`/`MultiEdit` on `goals.md`, `priorities.md`, `directives.md`, `SQUAD.md`. An agent that tries to edit one is refused by Claude Code itself ("denied by your permission settings") — no custom hook, no parsing.

**Interactive sessions are unaffected.** The founder's (and cofounder's) own Claude Code sessions don't get the injected `--settings`, so they edit governance files normally. The boundary is exactly *human-in-session can; autonomous agent can't* — including when the COO runs as a scheduled agent (it executes, it doesn't rewrite goals).

To change a governance file, a human edits it directly. There is no proposal queue — if an agent thinks a governance file should change, it files a normal GitHub issue.

## Known limits

- **`--dangerously-skip-permissions` bypasses deny rules.** If a spawn sets `SQUADS_SKIP_PERMISSIONS=1`, permissions (including these) are skipped. Keep that flag off for governed runs.
- **Deny rules cover the built-in edit tools, not arbitrary subprocesses.** A `Bash` redirect (`echo >> goals.md`) is not caught by an `Edit` deny rule. The OS sandbox (`SQUADS_SANDBOX=1`) adds filesystem-level defense-in-depth; the deny rules are carried through that path too.
