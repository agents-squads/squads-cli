# Releasing squads-cli

Single source of truth for how this package ships. Read this before touching
versions, tags, or workflows.

## TL;DR

1. **Prep PR to `develop`**: bump `package.json` + `package-lock.json`, add a
   `CHANGELOG.md` entry. No source changes in this PR.
2. **Release PR to `main`**: branch `release/vX.Y.Z` cut **from `main`**,
   tree set to `develop`'s exact tree (see [Squash divergence](#trap-squash-merge-divergence)).
   Verify `git diff develop` is empty. A maintainer reviews and squash-merges.
3. **Tag**: `git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z` —
   `release.yml` runs CI and creates the GitHub Release.
4. **Publish to npm** (maintainer only):
   ```bash
   gh workflow run publish.yml --repo agents-squads/squads-cli --ref main -f confirm=PUBLISH
   ```
5. **Verify**: `npm view squads-cli dist-tags.latest` shows the new version.
6. **Back-merge `main` → `develop`** to re-converge after the squash merge.

## Who publishes what

| Workflow | Trigger | Does |
|----------|---------|------|
| `publish.yml` | **Manual** `workflow_dispatch`, input `confirm=PUBLISH` | **The npm publisher.** OIDC trusted publisher configured on npmjs.com — no token. Publishes the `package.json` version; a `-` suffix (e.g. `0.8.0-rc.1`) goes to `@next`, otherwise `@latest`. |
| `release.yml` | Tag push (`v*`) | CI + GitHub Release. **Not** an npm publisher. |
| `ci.yml` | Push/PR to `main`, `develop` | PR gate: lint, typecheck, build, test on Node 20/22. |

Release authority is the maintainer's alone: automation and agents never push
release tags, merge to `main`, or dispatch `publish.yml`.

## Versioning

- **Forward-only semver.** Never reuse a published number — npm is immutable,
  a burned number stays burned. If a number was ever published (even later
  deprecated), skip past it.
- Check the ladder before picking a version:
  ```bash
  npm view squads-cli versions
  ```
- History note: `0.1.x`–`0.7.0` were consumed by early churn and are
  deprecated on npm. The active line restarted at `0.3.1`; the next minor
  after the `0.3.x` line is therefore `0.8.0`.
- Pre-releases use a `-rc.N` suffix and publish to the `@next` dist-tag.

## Pre-push validation

`npm run build` is tsup/esbuild — it does **not** typecheck or run tests.
CI's `build` job runs lint + typecheck + build + test. Before pushing
anything behavioral:

```bash
npm run typecheck && npm run test
```

## Known traps

### Trap: squash-merge divergence

`develop` → `main` PRs are squash-merged, so after each release `main` holds
the work as one new-SHA commit while `develop` keeps the originals. The next
develop→main PR then computes its diff from a stale merge-base and re-surfaces
the entire previous release (a 4-line fix once rendered as ~19k lines).

- The true delta is tip-to-tip: `git diff origin/main origin/develop`.
- Build release branches **from `main`**, then set the tree to `develop`'s
  exact tree and verify `git diff develop` is empty before pushing:
  ```bash
  git checkout -b release/vX.Y.Z origin/main
  git restore --source=origin/develop --worktree --staged :/
  git diff origin/develop   # must be empty
  ```
- For a `main`-targeted hotfix, branch from `main` and cherry-pick.
- **Always back-merge `main` → `develop` after a release** to re-converge.

### Trap: CI matrix parity

The PR gate (`ci.yml`) and the release gates (`release.yml`, `publish.yml`)
must test the **same Node versions**. They once diverged (PR gate on 20/22,
release on 18/20/22) and Node-18-only failures silently blocked three
releases while every PR stayed green. Both are now Node 20/22 — keep them
matched when bumping.

### Trap: release.yml's npm publish step (#819, open)

`release.yml` still contains an `npm publish` step that **always fails** —
only `publish.yml` is the OIDC trusted publisher. Until #819 lands, that
failure also blocks the GitHub Release step, so releases may need manual
backfill: `gh release create vX.Y.Z --generate-notes`.

## Milestone mapping

Milestones are titled `vX.Y.Z — theme`; a milestone closing means that
version ships. A release may span repos via a shared version key (a planning
milestone elsewhere plus this repo's milestone of the same `vX.Y.Z` is one
release).
