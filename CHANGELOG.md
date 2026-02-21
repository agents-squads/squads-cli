# Changelog

All notable changes to squads-cli will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-02-20

### Security
- fix(security): escape HTML in OAuth callback responses (#323)
- fix(security): prevent shell injection in agent spawn (#324)
- fix(security): restrict auth file permissions to owner-only (#325)
- security: remove internal infrastructure references from public repo

### Added
- feat(run): memory injection, event emission, Ralph verification loop
- feat(run): foreground default, status tracking, auto-commit
- feat(run): inject Output section with target repo into agent context
- feat(run): multi-provider model routing
- feat(run): enforce model routing from squad context
- feat(run): enforce branch isolation for agent execution
- feat(eval): implement squads eval readiness scorer (#305)
- feat(deploy): implement squads deploy command (#304)
- feat(dashboard): add ROI metrics, cost projections, and baseline command (#245)
- feat(context): add squad-scoped skills and MCP servers (#243)
- feat(autonomous): implement real scheduling daemon
- feat(cli): reposition as business OS for AI managers (v0.6.0)
- feat(cli): interactive init, session filtering, bug fixes from Santiago sim
- feat(cli): accept any model string for multi-provider routing
- feat(status): add execution observability to squad status
- feat(release): auto-update docs changelog on version bump (#270)
- feat: add privacy indicators to CLI output (#269)
- feat: add light mode terminal palette (#221)

### Changed
- refactor: remove pg, ioredis, supabase from CLI dependencies (#303)
- refactor(run): deprecate -e flag, add native Claude execution pattern
- refactor: clean up unused code

### Fixed
- fix: update memory tests to match new ## date format
- fix: add worktree isolation to executeWithProvider
- fix: use git worktrees for agent isolation instead of checkout
- fix: restore auto branch isolation for agent execution
- fix: unset CLAUDECODE env var to allow nested execution
- fix: skip --mcp-config when no squad MCP config exists
- fix: use array spawn for foreground mode to avoid shell escaping
- fix: auto-detect non-TTY and use --print in foreground mode
- fix: standardize learnings format for synthesizer parsing
- fix: point approval commands to squads-api instead of dead slack-bot
- fix: update trigger commands to use SQUADS_API_URL
- fix(cli): resolve 6 P1 issues — URLs, ANSI, errors, init, run checks, optional deps (#44bc09d)
- fix(ci): resolve smoke-test failure and npm audit vulnerability (#327)
- fix(lint): remove all unused imports/vars, replace require() with ESM import (#326)
- fix(run): add shell wrapper for Node 22 symlink resolution
- fix(run): include learnings in dry-run preview
- fix(login): update auth URL to api.agents-squads.com
- fix(login): show graceful "coming soon" message when auth unavailable
- fix(docker): add REDIS_URL to scheduler-api for event buffer
- fix(tests): skip tests for unimplemented baseline functions, fix SQL injection test (#253)
- fix(test): normalize temp paths for macOS compatibility
- docs: realign positioning to "Your AI workforce"
- docs: add backlinks to agents-squads.com

### Tests
- test: add comprehensive tests for core commands (#244)
- test: add comprehensive database operation tests (#246)
- test: extract cron functions to lib/cron.ts and add comprehensive tests (#301)
- test: add unit tests for anthropic.ts skill extraction functions (#239)
- test: add unit tests for terminal utility functions (#237)
- test: add unit tests for dashboard postgres source pure functions (#235)
- test: add unit tests for dashboard summary and table renderers (#234)
- test: add unit tests for dashboard bar and trend renderers (#233)
- test: add unit tests for dashboard list renderer (#232)
- test: add unit tests for dashboard base renderer utilities (#231)
- test: add unit tests for llm-clis.ts (#230)
- test: add unit tests for autonomous.ts core functions (#224)
- test: add unit tests for templates.ts and local.ts pure functions (#220)
- test: add comprehensive unit tests for lib/goal-parser.ts (#219)
- test: fix flaky memory tests on macOS (#242)

### CI
- ci: add P1 issue aging alert workflow (#236)

## [0.5.1] - 2026-01-27

See previous releases for earlier changelog entries.
