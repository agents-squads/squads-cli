# Agent Contract — schema + enforcement mapping

The Agent Contract is the typed, git-versioned definition of what one agent may do
(P0 of the "Chief = governed Claude-with-the-CLI" plan — hq spec
`chief-cli-runtime-2026-05-29.md`, tracker hq#418). It **formalizes** what
`SQUAD.md` + agent frontmatter + the 7-layer `run-context` already imply and adds
the governance fields that are missing today, with a hard `default: deny`.

- **Schema + derivation + validation:** `src/lib/agent-contract.ts`
- **Derive + check every agent:** `squads contract validate [--squad <name>] [--json]`
  (non-zero exit on any violation — gate it in CI / pre-commit in the repo that
  holds the agent definitions: hq, or a customer's).

P0 is **schema + validation only — no runtime behavior changes.** Enforcement is P1+.

## Field → Agent SDK primitive (the P1 enforcement target)

Enforcement lives in **one plane: the Agent SDK permission callback**
(`canUseTool` / `PreToolUse`) — not a separate CLI interceptor (it would race the
SDK's native gate). The launcher loads the contract INTO that callback. "Build glue
only for fields with no native equivalent" = don't rebuild what Anthropic ships.

| Contract field | SDK primitive (P1+) | Notes |
|---|---|---|
| `tool_grants` | `allowed_tools` (deny-by-omission) + `canUseTool` | Replaces the static shared `--allowedTools` array (`execution-engine.ts:741`). Vocabulary is constrained at validation to what the allowlist can express. |
| `hitl_gate` | `canUseTool`/`PreToolUse` → `ask` | v0: `ask` resolves to **dispatch-boundary approval** (queued job the founder approves), NOT mid-call pause. |
| `scoped_context` | `system_prompt` + `add_dirs` | `run-context` assembles the role's layers into the prompt; `context_from` dirs added. |
| `autonomy` | `permission_mode` | `suggest`→plan/default · `execute_with_gate`→gated · `autonomous`→bypass-with-audit (gated by evaluator results, later). |
| `resource_ceiling` | harness cost/turn caps + process `max_runtime` | Cost aggregated at `root_run_id` (P1); `max_runtime_s` = process deadline. |
| `default: deny` | empty `allowed_tools` baseline | Nothing is callable unless granted. |
| `write_scope` | **glue (P2):** OS sandbox writable-paths + `canUseTool` path check | No native SDK primitive — needs the sandbox. |
| `credential_scope` | **glue (P2):** per-subprocess env injection | Stripped env by default; secrets injected only where granted. |
| `workspace_id` | **glue (P5):** per-tenant isolation | Tenant key, `local` today; hosting = toggle. |
| `evaluator` | post-hoc grade in `executions.jsonl` | Quality scoring only — **NOT a safety gate.** |

## Validation rules (CI fails on)
- A `tool_grant` not expressible in the allowedTools vocabulary (tool name / `Bash(cmd:*)` / `mcp__server__tool`) → unenforceable.
- Missing `default: deny`; empty `tool_grants`; unknown `role`; empty `workspace_id`.
- A `write`/`consequential` grant with no `write_scope` (unjailed write).
- A `consequential` grant with `hitl_gate: none`.
- No `resource_ceiling.max_runtime_s` (unbounded run) or no cost ceiling.
- An unknown `credential_scope` secret; `autonomy: autonomous` together with a gate (contradiction).

## Status
P0 validates **all existing hq agents** (112 as of 2026-06-10; agent count grows over
time — run `squads catalog` for the live count) with conservative role-based defaults
(scanner/verifier read-only; worker +write-in-squad-memory; lead/coo +dispatch),
and rejects over-scoped/unenforceable contracts. Agents tighten their grants by
declaring `tool_grants`/`autonomy`/`hitl_gate`/`write_scope` in frontmatter; the
validator keeps them honest.
