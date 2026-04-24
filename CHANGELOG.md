# Changelog

All notable changes to `squads-cli` are documented here.

This project follows [Semantic Versioning](https://semver.org/).
Releases are also published as [GitHub Releases](https://github.com/agents-squads/squads-cli/releases).

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
