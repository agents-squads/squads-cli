# Changelog

All notable changes to `squads-cli` are documented here.

This project follows [Semantic Versioning](https://semver.org/).
Releases are also published as [GitHub Releases](https://github.com/agents-squads/squads-cli/releases).

## [Unreleased]

### Added
- **Run events carry `schema_version`** (#1341). Every line in `.agents/observability/events/<run>.jsonl` and in API event batches has `schema_version: 1`, and the v1 shape is exported as `schemas/exec-event.v1.schema.json`. Additive changes keep the version; removing or renaming a field or changing a type bumps it, with a changelog entry. See `docs/exec-events.md` → "Versioning and the exported schema".

## [0.10.1] — 2026-10-19

Security patch. No new features.

### Security
- **Secrets no longer reach event logs.** Run events are redacted at the single write point, before the events file and the API flush (private keys, token formats, URL credentials, `Authorization` headers, values from the local secret store and credential-named env vars), and every event carries a `sensitivity` level. Before this, a secret in a tool result was stored raw in the events file and flushed to the connected API. (#1303)
- **The opencode harness runs under the same governance as the Claude harness.** It no longer runs with `--auto`: tool grants become an opencode permission config (default deny), the guardrail deny rules are mapped, and the run is wrapped in the OS sandbox (`sandbox-exec` / `bwrap`). A grant or rule that can't be expressed refuses the run. (#1308)
- **Harvesting an agent's worktree can't run code from that worktree.** The worktree's `.git` link is checked against the one recorded at creation (harvest is refused on mismatch), and harvest git runs with hooks, fsmonitor, external diff and textconv filters disabled. (#1314)

### Fixed
- Harvest diffs against the commit the worktree was branched from, not the operator's current HEAD, so unrelated files no longer read as mass deletions and fail the run. #1314 builds on this. (#1312)

## [0.10.0] — 2026-10-14

Run agents on Claude and Anthropic-compatible providers, keep their work out of your checkout, and record what each run actually did.

### Behavior changes — read before upgrading
- **Auto-commit is opt-in and memory-only** (#1243). After a run, nothing is committed unless `SQUADS_AUTO_COMMIT=1`, and nothing is pushed unless `SQUADS_AUTO_PUSH=1` as well. When enabled, only `.agents/memory/<squad>/` is committed; your other changes, staged or not, are left alone. Commit subject is now `memory(<squad>/<agent>): …`. See `docs/configuration.md` → "Agent memory commits".
- **Smaller default agent tool grants** (#1253). Agents without `tool_grants` no longer get `curl`, `docker`, `duckdb`, `bq`, `gcloud`, `gws` or `stripe`. Add what an agent needs under the new `extra_tools:` frontmatter key (bare command names only). See `docs/configuration.md` → "Agent tools".
- **`squads memory sync --push`** commits only memory paths and pushes the current branch, never a hard-coded `main` (#1257). Run worktrees branch from the repo's own trunk: `develop` if it exists, else `origin/HEAD`, else `main`/`master` (#1257, #1274).
- **Provider work is never merged into your checkout** — foreground or background (#1151). The detached path now matches the foreground one: agent work stays on its own branch. Lanes run in their own worktree from the repo's trunk, not your current `HEAD` (#1257); a per-run guard blocks writes aimed at your primary checkout, and a detached lane whose worktree can't be created stops instead of falling back to your checkout (#1168). Review agent branches through `squads inbox`.
- **DeepSeek lanes run through the claude harness** on DeepSeek's Anthropic-compatible endpoint, replacing the aider delegation (#1163). They need the `claude` CLI installed; the generic `aider` lane remains.
- **`--provider` beats the agent's frontmatter `provider:`** (#1139).
- **`squads login` is hidden from `--help`** unless `SQUADS_AUTH_URL` is set; `--cloud` exits 1 at preflight ("Cloud dispatch requires login, which is not available in this build") when auth isn't configured. Personal email addresses are no longer rejected at signup (#1213).
- **Environment files**: the CLI reads `.env` in the current directory and `~/.squads/.env` (shell > current directory > user; existing variables are never overridden). The probes for fixed sibling-directory `.env` paths are gone. Slack notifications go to `SQUADS_SLACK_CHANNEL` (#1236).
- **`squads trigger`, `approval` and `deploy`** stop before any request with `<command> needs an API: set SQUADS_API_URL …` when no API URL is set; `deploy` also honours the config-file `api_url` (#1258).
- **Bot identity** (commit author, `--author` PR filters) comes from your configured GitHub App, or your own git identity when there is none (#1255).
- **Agent contracts**: credential names may be any environment-variable-shaped name (`^[A-Z][A-Z0-9_]*$`) instead of a fixed list; `squads review` decides a blocker "needs a human" by generic keywords in its text (`needs-human`, `owner`, …) instead of specific accounts (#1254).
- **Context layers renumbered L0–L6**, configurable in `.agents/context-policy.yml` (#1193, #1195). `founder-context.md` / `founder-alignment.md` are no longer injected into runs, and runs no longer spawn a background digest job (#1190).
- **Squad conversations stop on evidence, not prose**: `## STATUS: DONE` / `## VERDICT: APPROVED` only *propose* completion; the run converges when commits on the run branch, or a PR with green CI, confirm it (#1221, #1123).
- **Inbox** item kinds are `pr`, `run_branch`, `run_artifacts`, `coherence` and `strategy_proposal`; coherence items derive from `SQUAD.md` and strategy only, and the inbox no longer runs workspace scripts (#1036, #1254).
- **Run events**: `run_end.outcomes` is omitted when unknown instead of reporting zeros (#1069), and `model` is omitted instead of `"unknown"` (#1191, #1192). Event files gain optional v2 fields `source`, `provider`, `session_id`; v1 lines stay valid (#1161).
- A squad with no role table now warns and exits 1 instead of running zero agents (#1200). `squads orchestrate` checks for `tmux` and exits 1 with install hints when it is missing (#1237).
- New tagline: "Run squads of AI agents from your terminal — defined in markdown, tracked in git." The npm description, keywords, seed templates and in-product strings follow it; `squads init` commits as `feat: init agent squads` (#1226).
- The guardrail template drops its `MultiEdit` deny rules — Claude Code folded MultiEdit into Edit, and the Edit/Write rules keep the same protection (#1061).

### New commands
- `squads plan --json` — the roadmap from a plan-of-record GitHub issue (`plan_issue` in `.squads/config.yml` or `SQUADS_PLAN_ISSUE`): rows, order, blockers and sub-issues; unconfigured prints `{"configured": false}`, and an unreachable GitHub falls back to the last cached read (#1282)
- `squads domains [--days 7] --json` — per squad: goals (from memory `goals.md`), work delivered (merged PRs, closed issues) and work in flight, in one GitHub query; unreachable repos show as unknown, never zero (#1283)
- `squads board [--date] [--json]` — a day's executions with per-run tokens and cost, live runs and the incoming queue; includes Claude Code sessions, with estimated costs marked `~` (#1117, #1120, #1122, #1136)
- `squads runs --wait [<squad>[/<agent>]] [--json]` — block until a background run ends and print its summary; exits non-zero on error or after 40 minutes (#1115)
- `squads brief` — morning catch-up from a connected instance: delivered, needs you, pending (#1105, #1108, #1112)
- `squads report --for auditor --period 30d` — an evidence pack of what agents did, what it cost and who approved it, from local data (#1212)
- `squads context --for <run|tick|session> [--json]` — the assembled context with a per-layer manifest (#1193)
- `squads config use <env>` / `squads config show` (#1185)
- `squads add <name> --mission "…" -y` — non-interactive squad creation (#1086)

### Providers
- **Provider registry**: an Anthropic-compatible provider is a few lines of YAML in `~/.squads/providers.yaml` (`harness`, `base_url`, `required_env`, `models`) — no CLI release needed (#1224). `harness: native` entries dispatch through a headless engine binary (`SQUADS_ENGINE_BIN`) — experimental (#1228, #1230).
- Kimi (Moonshot) lane on the claude harness (#1206); opencode as a lane and as a fallback harness with full event parity (#1143, #1178)
- GLM lanes get the compiled tool allowlist (they were read-only in print mode) and real token telemetry; foreign-model cost comes from `SQUADS_<PROVIDER>_COST_PER_MTOK_IN/OUT` (e.g. `SQUADS_DEEPSEEK_…`, `SQUADS_KIMI_…`) and shows as unpriced until set — never Claude list prices (#1078, #1085, #1102, #1206)
- Every harness lane reports the same events, model and cost as a Claude lane (#1163, #1176, #1180, #1198)
- Lane child processes get no ambient GitHub credentials (#1088); aider no longer edits the target repo's `.gitignore` (#1141)

### Truthful runs
- **Run ledger**: a start row at spawn and a terminal row at exit, folded per run id, with an orphan reaper backed by real process liveness — `squads status` stops counting dead runs as running (#1145, #1199)
- Execution rows carry the task, the error and a result summary on success and failure (#1137, #1138, #1167), plus the Claude Code `session_id` (#1136) and a session-derived root for runs dispatched from a session (#1182, #1183)
- Runs that end mid-turn, hit `error_max_turns`, or stop while waiting on their own background subagent are recorded as failed, not completed (#1137, #1149)
- Harvest: a run that guts a file without replacing it is marked suspect and failed (#1079); harness-copied files are not mistaken for agent work (#1080)
- Detached runs: done-files are claimed atomically so a run is never recorded twice (#1148); the whole wrapper logs to the lane log (#1172); spawn failures land in the log (#1162); pid/log files live in the squad's target repo (#1152)
- Foreground runs report real outcomes parsed from the session (#1069) and print the memory growth at completion (#1204)
- Background runs register with a connected instance and stream step events to it in batches; the local event file stays authoritative (#1109, #1144, #1161)
- Outcome scorecards populate from settled records, so outcome-based routing works (#1217)

### Routing and dispatch
- Worktrees route to the repo a task names, within the squad's `also_owns` allowlist; an explicit `repo X` marker wins (#1094, #1096, #1173)
- `--cloud` dispatch carries the task, timeout and skills (#1107)
- Bot tokens re-mint on auth failure, so lanes longer than an hour still deliver (#1146); dispatch fails loud when a `gh`-granted background lane has no bot token (#1169)

### Security
- Setup guides print `set` / `not set`, never environment values (#1249)
- Memory push uses an env-scoped credential helper — no token in `argv` (#1251)
- Branch names used in commands are checked to be plain ref names; runs in a repo with no trunk base on `HEAD` (#1274)
- Memory write paths are validated before any `mkdir`/write (#1171)
- Dependency updates past open advisories (#1074, #1246); GitHub Actions pinned to commit SHAs with Dependabot updates (#1241)

### Portability
- No logic tied to the original team's repos, branch names, people or directory layout: attribution comes from each squad's `SQUAD.md` `repo:` (#1254, #1260, #1265)
- Fixed silent failures from bare `require()` in the ESM bundle: memory recency ranking, session cwd detection, update checks (#1262)
- Echo the canonical squad directory name in copy-paste commands (#1075); `squads doctor` counts only this project's running squads (#1063)
- `squads memory read` shows learnings next to state; writes default to the roster's lead agent (#1072)

### Docs and CI
- `docs/commands.md` covers the full command surface (#1197); README shows a real demo transcript and states local-first and telemetry opt-out (`DO_NOT_TRACK=1` / `SQUADS_TELEMETRY_DISABLED=1`) honestly (#1062, #1066); plainer `--help` text (#1065)
- Anonymous telemetry now sends a GA4 `session_id` and a once-per-install `first_open` event (#1215); opt out with `DO_NOT_TRACK=1` or `SQUADS_TELEMETRY_DISABLED=1`
- First runs print no guardrail warnings (#1061); fleet budget keys `daily_budget_usd` / `monthly_budget_usd` (`SQUADS_DAILY_BUDGET_USD` / `SQUADS_MONTHLY_BUDGET_USD`) are read into config, not yet enforced (#1036)

### Known issues
- `squads runs --wait` matches `<squad>[/<agent>]` only, not execution ids, so two runs of the same agent can't be told apart — #1281
- `squads inbox --json` can take close to a minute on orgs with many repos — #1278
- Background runs write step events only when they exit; live progress for detached runs is tracked in #1275

## [0.9.0] — 2026-07-07

The loop release: the CLI teaches the loop, presents it, and enforces its trust properties.

### The loop, taught and presented
- The seed skill teaches the operating rhythm — intent → execute → decide → learn — with the human-five split from agent working verbs (#1019)
- 62 visible commands become 25 canonical verbs; absorbed names keep working, hidden from `--help`, each printing its canonical replacement on stderr so piped output and `--json` stay clean (#1020)
- `docs/architecture.md` updated to the shipped loop: containment, bounded dispatch, the decision gate, measured feedback, initiative — with the canonical execution-loop diagram (light/dark)

### Trust enforcement
- **Inbox is truthful** (#1021): headless/autonomous decisions stamp `agent:<name>`, never a login identity the human didn't exercise; run-artifact rows reconcile against live PR state — landed work stops showing as "waiting"
- **The trunk is sacred** (#966): squad-level `--task` on a non-tool-use provider lane refuses with remedies instead of silently reinterpreting; provider harvest never fast-forwards the operator's checkout — work lands on the agent branch and integrates only through the inbox gate
- **Fresh bases** (#1014): run worktrees are cut from freshly-fetched `origin/develop`, never a stale local trunk (offline falls back with a visible warning)
- **One autonomy story** (#970): the orphaned in-CLI autopilot loop is deleted — autonomous cadence belongs to the platform heartbeat and the opt-in ambient `squads heartbeat` (upcoming)

### Behavior changes
- Provider-executed agent work is no longer auto-merged into your checkout on run completion — review it via `squads inbox` (this closes the path that could write to a repo's main without a human decision)
- `--help` lists the canonical surface only; `squads commands --json --all` still enumerates everything

## 0.8.3 — 2026-07-07

The first-run journey release: squads now works on a stranger's machine, verified by clean-room persona tests.

### Journey & truthfulness
- Fresh `squads init` scaffolds agents that can actually run — init/runtime provider vocabulary unified (#955)
- Bare machines (no AI CLI installed) init in planning-only mode with the full provider install list — never a silent claude scaffold, never a wall (#977)
- `squads propose` — one bounded background run turns repo intent into a reviewable proposal branch + inbox card (#983)
- Every command reports usage via one root hook — command path + flag names + duration + success ONLY; this pass also removed 29 legacy events that leaked squad names and search queries in violation of the telemetry disclosure (#1009)
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
