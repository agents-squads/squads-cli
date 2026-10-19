# Squad governance

Squads are autonomous within bounds. Governance files set those bounds — and **only a human in an interactive session sets them.** Autonomous agents execute against those bounds; they cannot rewrite them.

## Authority by file

| File | Set by | Written by autonomous agents? |
|------|--------|-------------------------------|
| `strategy.md` (primary company context) | Founder (+ cofounder, in session) | ❌ blocked |
| `directives.md` (legacy fallback) | Founder (+ cofounder, in session) | ❌ blocked |
| `goals.md` (per squad) | Founder (+ cofounder, in session) | ❌ blocked |
| `SQUAD.md` (atemporal identity) | Founder | ❌ blocked |
| `state.md`, `learnings/` | Squad agents | ✅ allowed (this is their job) |

Governance files set the **target**; memory files capture the **trajectory**. If agents could rewrite both, they'd drift from the founder's intent run by run. Letting agents write memory but not governance is the minimum viable separation.

## How it's enforced

`squads run` (and the daemon) launch each agent with `--settings templates/guardrail.json`, which carries native Claude Code `permissions.deny` rules for `Edit`/`Write` on `goals.md`, `directives.md`, `SQUAD.md`. An agent that tries to edit one is refused by Claude Code itself ("denied by your permission settings") — no custom hook, no parsing.

**Interactive sessions are unaffected.** The founder's (and cofounder's) own Claude Code sessions don't get the injected `--settings`, so they edit governance files normally. The boundary is exactly *human-in-session can; autonomous agent can't* — including when the COO runs as a scheduled agent (it executes, it doesn't rewrite goals).

To change a governance file, a human edits it directly. There is no proposal queue — if an agent thinks a governance file should change, it files a normal GitHub issue.

## Kimi Code harness (`kimi-code`)

`SQUADS_HARNESS=kimi-code` or `--model kimi-code/<alias>` runs a lane on the user's Kimi For Coding **subscription** via `kimi -p`. That mode cannot be combined with `--auto` and approves every tool, so none of the controls above can ride on kimi's own permissions. Governance comes from the runner instead (`src/lib/kimi-code-governance.ts`), and it **fails closed**:

- **Contract.** An agent with explicit `tool_grants` must grant `Bash`, `Read`, `Write` and `Edit` unscoped — kimi cannot withhold a tool or scope a command prefix, so a narrower contract (scoped `Bash(git:*)`, read-only, any MCP grant) refuses the run instead of being silently widened. The unscoped default surface runs, with a warning that shell scope is the sandbox.
- **Guardrail.** The `Edit/Write(**/goals.md)`-style deny rules become OS-sandbox write denies (macOS Seatbelt, case-insensitive) — which also closes the bash-redirect vector described below for these lanes. Any other rule shape, or Linux `bwrap` (no path-name rules), refuses the run.
- **OS sandbox.** The spawn is wrapped in `sandbox-exec` / `bwrap`: writes only to the worktree, the git common dir, memory, `~/.kimi-code/{sessions,logs,session_index.jsonl}` and tmp; credential dirs unreadable. `~/.kimi-code/bin`, `config.toml` and the credentials are not writable. `SQUADS_SANDBOX=0` is refused while the guardrail has deny rules; `SQUADS_SANDBOX_STRICT=1` refuses when no sandbox exists.
- **Credentials.** `KIMI_API_KEY`, `MOONSHOT_API_KEY` and `ANTHROPIC_*` are stripped from the spawn env, so a lane can only use the subscription login — never a metered key.

Gaps (same class as the opencode harness): no network allowlist (filesystem isolation only); the destructive-command hook (`git push --force`, `reset --hard`) has no equivalent in `kimi -p`, backstopped only by the sandbox and the stripped `GH_TOKEN`; kimi's own OAuth credentials must stay readable to it, so a lane can read them.

## Known limits

- **`--dangerously-skip-permissions` bypasses deny rules.** If a spawn sets `SQUADS_SKIP_PERMISSIONS=1`, permissions (including these) are skipped. Keep that flag off for governed runs.
- **Deny rules cover the built-in edit tools, not arbitrary subprocesses.** A `Bash` redirect (`echo >> goals.md`) is not caught by an `Edit` deny rule. The OS sandbox (`SQUADS_SANDBOX=1`) does **not** close this gap for files inside the repo: its `allowWrite` includes the workspace root, so a bash redirect to a governance file *within* the project still succeeds — the sandbox restricts writes to *outside* the workspace, not within it. (The deny rules are still carried through the sandbox path, so the built-in-tool protection holds in both modes.) Closing the bash-redirect vector would need a sandbox `denyWrite` entry for the governance paths — tracked as a follow-up.
