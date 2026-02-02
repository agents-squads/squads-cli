#!/bin/bash
# Release script for squads-cli
# Usage: ./scripts/release.sh [patch|minor|major]
#
# Steps:
# 1. Bump version in package.json
# 2. Build the project
# 3. Run tests
# 4. Create git tag
# 5. Push to GitHub
# 6. Create GitHub release with artifacts
# 7. Publish to npm

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Check args
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo -e "${RED}Usage: $0 [patch|minor|major]${NC}"
  exit 1
fi

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo -e "${RED}Error: Uncommitted changes. Commit or stash first.${NC}"
  git status --short
  exit 1
fi

# Check we're on main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo -e "${YELLOW}Warning: Not on main branch (on $BRANCH)${NC}"
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# Check npm auth
if ! npm whoami &>/dev/null; then
  echo -e "${RED}Error: Not logged in to npm. Run 'npm login' first.${NC}"
  exit 1
fi

# Check gh auth
if ! gh auth status &>/dev/null; then
  echo -e "${RED}Error: Not logged in to GitHub CLI. Run 'gh auth login' first.${NC}"
  exit 1
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}                    squads-cli release${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${YELLOW}Current version:${NC} $CURRENT_VERSION"

# Bump version
echo -e "\n${YELLOW}[1/7] Bumping version ($BUMP_TYPE)...${NC}"
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}New version:${NC} $NEW_VERSION"

# Build
echo -e "\n${YELLOW}[2/7] Building...${NC}"
bun run build
echo -e "${GREEN}✓ Build complete${NC}"

# Test
echo -e "\n${YELLOW}[3/7] Running tests...${NC}"
bun test || {
  echo -e "${RED}Tests failed. Reverting version bump.${NC}"
  git checkout package.json package-lock.json 2>/dev/null || true
  exit 1
}
echo -e "${GREEN}✓ Tests passed${NC}"

# Create tarball for GitHub release
echo -e "\n${YELLOW}[4/7] Creating release artifact...${NC}"
TARBALL="squads-cli-$NEW_VERSION.tgz"
npm pack
mv "squads-cli-$NEW_VERSION.tgz" "$TARBALL"
echo -e "${GREEN}✓ Created $TARBALL${NC}"

# Commit and tag
echo -e "\n${YELLOW}[5/7] Committing and tagging...${NC}"
git add package.json package-lock.json
git commit -m "chore: release v$NEW_VERSION

🤖 Generated with [Agents Squads](https://agents-squads.com)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
Co-Authored-By: Gemini 3 🍌 <noreply@google.com>"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
echo -e "${GREEN}✓ Tagged v$NEW_VERSION${NC}"

# Push to GitHub
echo -e "\n${YELLOW}[6/7] Pushing to GitHub...${NC}"
git push origin main
git push origin "v$NEW_VERSION"
echo -e "${GREEN}✓ Pushed to GitHub${NC}"

# Create GitHub release
echo -e "\n${YELLOW}[7/7] Creating GitHub release...${NC}"

# Generate changelog from commits
PREV_TAG=$(git describe --tags --abbrev=0 HEAD~1 2>/dev/null || echo "")
if [[ -n "$PREV_TAG" ]]; then
  COMMITS=$(git log "$PREV_TAG"..HEAD~1 --pretty=format:"- %s" --no-merges | grep -v "^- chore: release")
else
  COMMITS=$(git log --oneline -20 --pretty=format:"- %s" --no-merges | grep -v "^- chore: release" | head -15)
fi

# Categorize commits
FEAT_COMMITS=$(echo "$COMMITS" | grep "^- feat" | sed 's/^- feat[^:]*: /- /' || true)
FIX_COMMITS=$(echo "$COMMITS" | grep "^- fix" | sed 's/^- fix[^:]*: /- /' || true)
OTHER_COMMITS=$(echo "$COMMITS" | grep -v "^- feat\|^- fix\|^- chore\|^- docs\|^- test\|^- ci" || true)

RELEASE_NOTES="## squads-cli v$NEW_VERSION

A CLI for humans and agents - manage AI agent squads with comprehensive dashboards, telemetry, and team coordination.

### Installation

\`\`\`bash
npm install -g squads-cli
\`\`\`

### What's New
"

[[ -n "$FEAT_COMMITS" ]] && RELEASE_NOTES+="
#### Features
$FEAT_COMMITS
"

[[ -n "$FIX_COMMITS" ]] && RELEASE_NOTES+="
#### Bug Fixes
$FIX_COMMITS
"

[[ -n "$OTHER_COMMITS" ]] && RELEASE_NOTES+="
#### Other Changes
$OTHER_COMMITS
"

RELEASE_NOTES+="
### Full Changelog

See [commits since v$CURRENT_VERSION](https://github.com/agents-squads/squads-cli/compare/v$CURRENT_VERSION...v$NEW_VERSION)

---

🤖 Generated with [Agents Squads](https://agents-squads.com)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
Co-Authored-By: Gemini 3 🍌 <noreply@google.com>"

gh release create "v$NEW_VERSION" "$TARBALL" \
  --title "v$NEW_VERSION" \
  --notes "$RELEASE_NOTES"
echo -e "${GREEN}✓ GitHub release created${NC}"

# Update docs changelog
echo -e "\n${YELLOW}[8/9] Updating docs changelog...${NC}"
DOCS_DIR="${DOCS_DIR:-$HOME/agents-squads/docs}"

if [[ -d "$DOCS_DIR" ]]; then
  cd "$DOCS_DIR"
  git pull --rebase origin main 2>/dev/null || true

  # Generate release title from commits
  if [[ -n "$FEAT_COMMITS" ]]; then
    RELEASE_TITLE=$(echo "$FEAT_COMMITS" | head -1 | sed 's/^- //' | cut -c1-40)
  else
    RELEASE_TITLE="Bug Fixes & Improvements"
  fi

  # Convert commits to JSON arrays for the script
  FEAT_JSON=$(echo "$FEAT_COMMITS" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")
  FIX_JSON=$(echo "$FIX_COMMITS" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")

  # Run the changelog update script
  DOCS_DIR="$DOCS_DIR" node "$SCRIPT_DIR/update-docs-changelog.cjs" \
    "$NEW_VERSION" \
    "$RELEASE_TITLE" \
    "$FEAT_JSON" \
    "$FIX_JSON"

  # Commit and push
  git add changelog.mdx
  git commit -m "docs(changelog): add v$NEW_VERSION release

Co-Authored-By: Claude <noreply@anthropic.com>" || echo "No changes to commit"
  git push origin main

  cd "$PROJECT_DIR"
  echo -e "${GREEN}✓ Docs changelog updated${NC}"
else
  echo -e "${YELLOW}⚠ Docs repo not found at $DOCS_DIR - skipping changelog update${NC}"
fi

# Publish to npm
echo -e "\n${YELLOW}[9/9] Publishing to npm...${NC}"
npm publish --access public
echo -e "${GREEN}✓ Published to npm${NC}"

# Cleanup
rm -f "$TARBALL"

echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Released squads-cli v$NEW_VERSION${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}npm:${NC}    https://www.npmjs.com/package/squads-cli"
echo -e "  ${CYAN}github:${NC} https://github.com/agents-squads/squads-cli/releases/tag/v$NEW_VERSION"
echo ""
