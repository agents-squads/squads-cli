# Releasing squads-cli

Single source of truth for how this package ships. Read this before touching
versions, tags, or workflows.

## TL;DR

1. **Prepare the release**: run `squads release train --outcome <id>` (see
   [Release train](#release-train)). It checks the outcome's items, bumps
   `package.json` + `package-lock.json`, builds the `CHANGELOG.md` entry from
   the outcome, regenerates the seed skill reference, runs release-check, and
   opens the release PR. Doing it by hand means the same edits on a
   `release/vX.Y.Z` branch.
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

## Release train

A release is defined by an **outcome**, not by a count of merged PRs. The
routine path is one command:

```bash
squads release train --outcome O1 --dry-run   # print the plan; changes nothing
squads release train --outcome O1             # prepare the branch and open the PR
```

The gate reads its data from the **release source ref** (default
`origin/develop`), never from the operator's working tree: the HQ repo's
`.agents/roadmap.json` (found through the org root), or this repo's own
roadmap when it has one, and this repo's `.agents/features.json` as they exist
at the source. It **refuses** — naming each blocking item and why — unless
every item is `passing` with a verification whose `model` differs from
`builder_model` and whose `sha` is an ancestor of the release source. An
outcome release always takes the **minor** slot (see
[Versioning](#versioning)). The changelog lists one line per item (title +
issue), then **Also included** for the other merged PRs, dropping `chore` /
`deps` lines. Items owned by sibling repos are reported in the release body as
**Cross-repo items (not gated by this repo)** with their status; they do not
block this release.

### Commit gate and the allowlist

Before anything is prepared, every commit in the release range
`<merge-base(target, source)>..source` must be attributable to a PR — a
subject ending in `(#N)` or a `Merge pull request #N` subject. Release
housekeeping, back-merge subjects, and merges of already-known refs are
exempt. A commit with no PR reference **refuses the release**.

Commits that predate PR attribution are exempted explicitly, one reviewed
entry at a time, in `.agents/release-allowlist.json` (read from the release
source ref, so the entry must be merged before it can exempt anything):

```json
{
  "commits": [
    { "sha": "8b891fd", "reason": "predates PR attribution; reviewed 2026-10-20" }
  ]
}
```

`sha` is a full 40-character sha or a 7+ character prefix; `reason` is
required and non-empty. The plan (human, and `--json` as
`allowlisted_commits`) and the release PR body list every allowlisted commit
with its reason. A malformed allowlist refuses the release rather than
silently disabling the gate. Add an entry only after reviewing the commit; the
three seeded entries are 2026 history that predates attribution.

Security patches take a separate path. `--patch` skips the outcome gate but
accepts only PR titles that start with `security` or `fix`; anything else
refuses the release. In patch mode the attributed PR set must also equal the
admitted security/fix set exactly: an extra `feat` pushed straight to
`develop`, or an admitted PR with no commit in the range, refuses the release.

The train then:

- creates `release/vX.Y.Z` from `origin/main` and sets its tree to
  `origin/develop`, avoiding the [squash divergence](#trap-squash-merge-divergence);
- bumps `package.json` / `package-lock.json`, inserts the changelog entry, and
  regenerates the seed skill reference;
- runs release-check — `npm run build`, `npm run gen:skill`, `npm run lint`,
  `npm run typecheck`, `npm test`, plus the version/changelog consistency
  checks — and does not open the PR if any check fails;
- opens the PR to `main` with the changelog and the check output.

Other merged PRs are taken from GitHub's merged-PR list for `develop`,
filtered to those merged after the tag's commit date; without `gh` it falls
back to squash subjects in `git log --since`. It never tags, publishes, or
dispatches a workflow — steps 3–6 above stay with the maintainer.

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
- An **outcome release always takes the minor slot** on a 0.x line
  (`0.10.0` → `0.11.0`), even when every merged PR in the batch is a fix or
  the commits landed without PRs. `--patch` releases take the patch slot.
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
