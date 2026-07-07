# Changelog

All notable changes to `squads-cli` are documented here.

This project follows [Semantic Versioning](https://semver.org/).
Releases are also published as [GitHub Releases](https://github.com/agents-squads/squads-cli/releases).

## 0.8.3 — 2026-07-07

The first-run journey release: squads now works on a stranger's machine, verified by clean-room persona tests.

### Journey & truthfulness
- Fresh `squads init` scaffolds agents that can actually run — init/runtime provider vocabulary unified (#955)
- Unauthenticated or missing claude fails LOUD with the exact remedy and a nonzero exit (#956, #957); doctor reports real auth state and exits 1 on missing core tools
- README quickstart works verbatim: `git init` step, auth note, demo verification; deprecated autopilot example removed (#958, decision tracker #970)

### Local-first trust
- Fresh installs default to the `local` environment; auto-update is notify-only (opt-in `SQUADS_AUTO_UPDATE=1`); the optional init email stays on your machine (#959)
- squads never touches your personal Claude settings: the `~/.claude.json` trust mutation is gone, generated MCP configs live in your project, session-usage reads are project-scoped (`squads usage --all-claude` for machine-wide) (#960)
- Init lists the session hooks it installs and asks before enabling push-on-session-end (#963)
- Anonymous usage telemetry disclosed at init; journey events with a blocked-reason taxonomy; CI/test runs never phone home (#964)

### Works with just git — no GitHub required
- `squads inbox approve` lands work locally (squash-merge to your trunk) when there's no remote or gh (#979)
- Machines with no git identity get a commit-scoped fallback — init commits for real and run isolation survives (#980)

### Smarter conversations (Missions-informed)
- Structured handoffs: turns report commands + exit codes + undone work; self-contradicted DONE claims are rejected (#990)
- Validation contracts: plans define done before code; the verifier checks every assertion (#989, persisted per run #995)
- Bounded remediation: a REJECTED verdict triggers exactly one scoped fix round (#994)
- Deliver-and-stop gate matches closing keywords only (#971); scoped `--task` runs use a lead+delegate roster (#951)

### Testing
- Clean-room persona battery (`test/e2e/personas/`): synthetic users — newcomer, unauthenticated, no-git-identity, no-remote — assert the journey on every change (#997)

## [0.8.2] — 2026-07-01

Trustworthy execution — per-squad pause/resume enforcement, no silent loss of
deliverables, a verified context-injection layer (strategy.md as L1), and a
quota-aware org runner that survives quota walls.

### Added
- **Per-squad pause / resume enforcement** (#877) — `squads pause <squad>` makes `run`, `--org`, and cron dispatch refuse that squad until `squads resume <squad>`; the runner prints how to resume or override with `--force`. Activation state is enforced by the runner and honored by the org planner, so a paused squad can't be dispatched by accident.
- **Context loader: `strategy.md` is the L1 company layer** (#876) — the Squad Context System now reads `memory/company/strategy.md` as the primary "why" layer (falling back to `company.md` → `directives.md`), matching the single-strategy-file model. Context-layer docs updated.
- **Quota-aware org runner** (#861) — `squads run --org` probes quota before dispatching; `--wait-for-quota` polls until the session window reopens instead of stopping. Pre-flight `--dry-run` prints which squads would run without spending quota.
- **Post-run ingest ping** (#870) — after a run's execution record lands in `executions.jsonl`, the CLI fires a fire-and-forget `POST /ingest/trigger` to the local squads-api so usage analytics update immediately instead of waiting for the periodic sweep. Silent no-op when the API isn't running.

### Fixed
- **No silent loss of run deliverables** (#875) — a squad run whose lead ended BLOCKED on git/gh write-approval left its deliverable uncommitted in the per-run worktree, which cleanup then destroyed with `git worktree remove --force`. Cleanup now auto-commits any uncommitted/untracked work to the run branch (recoverable from the shared `.git`) and best-effort pushes it before removing the directory; if the work can't be preserved, the worktree is left in place instead of deleted.
- **Stale memory no longer reads as current** (#893) — `feedback.md` was injected under "act on this first" with no age caveat (only `state.md` had one), so a months-old correction looked current. A shared staleness helper now caveats both layers (`Last updated N days ago — verify before relying on this`). Adds real fixture-based tests for the context loader's layer order, role gating, `strategy.md`-as-L1, and budget behavior (previously asserted nothing).
- **`squads run SQUAD AGENT` now routes to the agent** (#866) — passing the agent as a second positional (`squads run engineering code-review`) was silently ignored and ran the whole squad. All three notations now produce identical results: `SQUAD/AGENT`, `SQUAD AGENT`, and `SQUAD -a AGENT`.
- **Session-limit quota variant detected** (#860) — loud failure printed when quota hits mid-conversation instead of a silent empty result.
- **Detached runs pinned to their own session id** (#862) — background runs that escaped their session were attributed to the wrong squad's usage budget.
- **Agents can run their own shell scripts** (#900) — `Bash(bash:*)` and `Bash(sh:*)` added to the agent tool allowlist in both spawn paths (single-agent and conversation), so an agent invoking a co-located helper script no longer stalls on a permission it can never grant.

## [0.8.1] — 2026-06-11

Run containment + introspection — background runs are recorded, bounded,
and controllable; the command tree is machine-readable.

### Added
- **Detached-run observability** (#849) — background/scheduled runs write an atomic done-file on exit; the next CLI invocation reconciles it into `executions.jsonl` with real token/cost usage. Detached runs were previously invisible to `squads usage` and budgets.
- **Watchdog timeout** (#850) — detached executors are reaped at their deadline (`SQUADS_AGENT_TIMEOUT_MINUTES` > `--timeout` > 15 min); the wrapper survives the kill, so a reaped run still harvests its work and reports `status: timeout`. Built from live evidence of an executor deadlocking post-completion.
- **`squads runs` / `squads kill`** (#852) — live background-run inventory across all squad repos; graceful stop (executor first, so the run still reports); `runs --clean` salvages crashed runs and clears stale pid files.
- **`squads commands --json`** (#842) — the live command tree as data, from the Commander registry; feeds the docs site, the seed skill, and agent discovery.
- **`SQUADS_AIDER_MAP_TOKENS`** (#847) — cap the aider executors' repo-map token budget (measured ~4.6k overhead on a small repo, far more on monorepos).
- **Release → docs dispatch** (#843) — releases notify the docs repo to regenerate its CLI reference (requires `DOCS_DISPATCH_TOKEN`; weekly cron otherwise).

### Fixed
- **Provider runs route to the squad's bound repo** (#846) — single-agent provider runs ignored `SQUAD.md repo:` and worktree'd/harvested onto whatever repo dispatched them. Live-validated both directions.
- **One canonical commit identity per AI provider** (#839) — `Claude <noreply@anthropic.com>` everywhere; detached harvests author as the user's git identity instead of a hardcoded bot email (was inflating contributor counts with phantom entries).
- **Seed skill reference generated, never hand-written** (#848, #851) — built from `squads commands --json` with a CI drift-guard; ships in `squads init` so new users get a current capability map.

### Security
- Cleared all 9 dependabot alerts (6 high) — lockfile-only transitive bumps (#833).

### Docs
- README rewritten: 640-line manual → 105-line front door + 8-page `docs/` (#836); `openapi-ts` config co-located with its spec (#835); `AGENTS.md` is the single agent-instructions source, `CLAUDE.md` imports it (#841).

## [0.8.0] — 2026-06-10

Trustworthy execution — multi-provider executors with full run observability.
(Jumps from 0.3.3: `0.4.x`–`0.7.0` were consumed by pre-reset publishes and
versions are forward-only — see `RELEASING.md`.)

### Added
- **DeepSeek provider via aider delegation** (#822) — `provider: deepseek` in agent frontmatter (or `--provider` flag, or squad `providers.default`) delegates execution to aider with `--model deepseek/deepseek-chat`. File-based roles only (no web tools); the OpenAI-compatible seam makes further providers a config swap.
- **Per-run outcome capture** (#818) — observability records now capture what each run actually produced: actions, commits, PRs, issues.
- **Provider run observability** (#826) — every foreground provider run writes an observability record; real token/cost figures parsed from executor output via the new `CLIConfig.parseUsage` seam (implemented for `aider`/`deepseek`); agent `model:` frontmatter is now parsed so records carry the agent's real model.

### Fixed
- **Executor work can never be lost** (#825) — provider-executor output is harvested from the isolated worktree (commit → ff-merge into the project root, guarded by the secret/PII staged-diff scan) instead of being destroyed with it. On divergence the `agent/*` branch is preserved with the manual-merge command printed; harvest runs on failed exits too, so partial work survives.
- **Tag pushes produce GitHub Releases again** (#819) — `release.yml` dropped its always-failing npm-publish step (only `publish.yml` is the OIDC trusted publisher), which had been blocking GitHub Release creation.

### Docs
- **`RELEASING.md`** (#827) — in-repo release procedure: publish path, version ladder, squash-divergence recipe, known traps.

## [0.3.3] — 2026-06-08

Runtime reliability — `squads run` is safe and pleasant to leave unattended.

### Fixed
- **Per-agent timeout now actually bounds agents** — `--timeout <min>` was ignored in conversation mode; it now caps each agent (precedence: `SQUADS_AGENT_TIMEOUT_MINUTES` env > `--timeout` > default). Default lowered **30 → 15 min** so a hung agent can't burn half an hour (#806).
- **Founder-context refresh no longer blocks the run** — when context is stale, the digest now refreshes in the **background** while the run proceeds with the current copy (was a multi-minute synchronous Pass-1 over the whole session history). `--force` / `SQUADS_DIGEST_SYNC=1` still refresh synchronously (#807).

### Added
- **Per-squad-run worktree isolation** — each squad run executes in its own git worktree, so agents never switch branches, drop files, or open PRs in your working checkout. Graceful fallback to in-place if the dir isn't a git repo; `SQUADS_NO_WORKTREE=1` to disable (#808).

### Changed
- `squads run` (no target) now lists squads and surfaces a `Run all squads: squads run --org` hint; corrected the misleading "autopilot mode" command description (#805).

## [0.3.2] — 2026-06-08

Agent runtime, founder-context, and a full safety/governance layer.

### Added
- **Founder-context layers** — `founder-context.md` (universal) + per-squad `founder-alignment.md` injected first into every agent's context, so squads run aligned with the operator's live pipeline.
- **`squads brief`** — distills founder intentions from recent sessions into GitHub issues.
- **Live `--verbose` streaming** — `squads run --verbose` streams each agent's output as it works (not just post-run).
- **Per-agent `max_context_tokens`** — cap an agent's context-assembly budget in YAML frontmatter.
- **Agent Contract** — schema + CI validator for agent capabilities (tool grants, write scope, credential scope, resource ceilings).
- **OS sandbox** (opt-in) — run agent sessions in Claude Code's OS sandbox with an egress allowlist.
- **API type codegen** — generated client types from the squads-api OpenAPI spec.

### Changed
- **Roadmap-bounded autonomy** — leads plan, delegate, update state, and land reviewed PRs, but cannot author or ship code themselves; workers do the building.
- **Role-based timeouts + anti-collision** rules in the conversation engine.
- **Requires Node ≥ 20** — dropped EOL Node 18 from the test/release matrices; the bundled `vitest`/`rolldown` toolchain imports `styleText` from `node:util`, available only on Node ≥ 20.

### Fixed
- **Release pipeline** — `release.yml`/`publish.yml` no longer fail on Node 18, which had silently blocked the last two tagged releases from publishing to npm.
- Telemetry write-key restored (broken since 2026-03-14).
- Services made path-agnostic (no hardcoded paths).
- Agent guardrail Bash denylist now actually fires.
- UX: prerequisites check, no-args squad list, schedule hint.

### Security
- **Secret/PII guardrail** — blocks agent auto-commits that would leak secrets or PII.
- **Governance deny-rules** — agents can't edit `goals`/`priorities`/`directives`/`SQUAD.md` during runs.
- Defensive validation hardening across contract / secret-scan / brief / sandbox.

## [0.3.1] — 2026-04-24

First stable v0.3.x release on `@latest`. Same code as `0.3.0-rc.1` (burned in on `@next`).

> Note: `0.3.0` was skipped because that version slot is reserved by a deprecated historical pre-release (Jan 2026) and npm enforces version immutability.

### Added
- **Conversation protocol** — agents talk to each other and use tools mid-conversation. `squads run <squad>` now drives a lead → scan → work → review → verify cycle.
- **Org cycle** — `squads run` with no target runs all squads in waves, with smart-skip for converged work.
- **New commands** — `review`, `credentials`, `goals`, `log`, plus minor refinements to `init`, `status`, and `run`.
- **Project config system** — `.squads/config.yml` for per-project settings (`agent_timeout_minutes`, `token_budget`, `cost_ceiling`, `company_name`, `compose_file`, `telemetry`). Resolution: env var > config file > defaults.
- **PreToolUse guardrail hooks** — agent sessions can be gated by user-defined safety hooks.
- **Demo agent scaffold** — `squads init` now includes starter agents and "what's next" guidance.
- **Growth squad template** — added to `squads init` seed templates.
- **Tier 2 documentation** — guides for local-services mode (Postgres, Redis, API, Bridge).

### Changed
- **Run engine rewrite** — decomposed into smaller modules (`conversation.ts`, `workflow.ts`, context helpers). Foundation for future cloud execution.
- **Role-based timeouts** — workers, reviewers, and leads have appropriate per-role timeouts (replaces hardcoded 8-minute ceiling).
- **Anti-collision rules** — multiple squads no longer race to create the same release PR or duplicate issues.
- **Prompts extracted** — lead briefings, planning instructions, and orchestrator prompts moved from TypeScript into `templates/prompts/*.md`.
- **Services command** — agnostic compose-file discovery (no hardcoded internal paths).
- **OIDC trusted publishing** — `release.yml` and `publish.yml` now publish via GitHub OIDC instead of `NPM_TOKEN`. No long-lived secret to rotate.
- **Audit remediation** — removed hardcoded values, parameterized company name, extracted internal prompts.

### Fixed
- **Telemetry write-only key** — restored after being incorrectly removed in March (telemetry has been silent since 2026-03-14).
- **First-run UX** — prerequisites check, helpful empty-state for `squads list` with no squads, schedule hint after first run.

### Infrastructure
- `@next` dist-tag channel — pre-release tags (`v0.3.0-rc.1`, `v0.4.0-beta.1`, etc.) auto-publish to `@next` for burn-in. Clean semver tags publish to `@latest`.
- npm install via `npm i -g squads-cli@next` for early access.

## [0.2.2] — 2026-03-28

- IDP (Internal Developer Platform), observability infrastructure, tiered architecture, org cycle scaffolding.

## [0.2.1] — 2026-03-13

- First-run experience reset.

## [0.2.0] and earlier

See [GitHub Releases](https://github.com/agents-squads/squads-cli/releases) for the full history.

> Versions `0.3.0`, `0.4.0`–`0.4.13`, `0.5.0`–`0.5.1`, `0.6.0`–`0.6.2`, and `0.7.0` were experimental pre-releases published in early 2026 and have been **deprecated** on npm. Do not install them. Start at `0.2.2` or `0.3.1+`.

[0.3.1]: https://github.com/agents-squads/squads-cli/releases/tag/v0.3.1
[0.2.2]: https://github.com/agents-squads/squads-cli/releases/tag/v0.2.2
[0.2.1]: https://github.com/agents-squads/squads-cli/releases/tag/v0.2.1
