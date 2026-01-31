#!/usr/bin/env node
/**
 * Update docs changelog with new release entry
 * Usage: node update-docs-changelog.js <version> <title> [features] [fixes]
 */

const fs = require('fs');
const path = require('path');

const [,, version, title, featuresJson, fixesJson] = process.argv;

if (!version || !title) {
  console.error('Usage: update-docs-changelog.js <version> <title> [featuresJson] [fixesJson]');
  process.exit(1);
}

const docsDir = process.env.DOCS_DIR || path.join(process.env.HOME, 'agents-squads/docs');
const changelogPath = path.join(docsDir, 'changelog.mdx');

if (!fs.existsSync(changelogPath)) {
  console.error(`Changelog not found: ${changelogPath}`);
  process.exit(1);
}

// Parse features and fixes from JSON
let features = [];
let fixes = [];
try {
  if (featuresJson) features = JSON.parse(featuresJson);
  if (fixesJson) fixes = JSON.parse(fixesJson);
} catch (e) {
  // If not valid JSON, treat as newline-separated strings
  if (featuresJson) features = featuresJson.split('\n').filter(Boolean);
  if (fixesJson) fixes = fixesJson.split('\n').filter(Boolean);
}

// Build entry
const date = new Date().toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
});

let entry = `### v${version} - ${title}

<Note>
  Released ${date}
</Note>
`;

if (features.length > 0) {
  entry += `
**Features:**
${features.map(f => `- ${f.replace(/^- /, '')}`).join('\n')}
`;
}

if (fixes.length > 0) {
  entry += `
**Fixes:**
${fixes.map(f => `- ${f.replace(/^- /, '')}`).join('\n')}
`;
}

entry += `
---

`;

// Read current changelog
let content = fs.readFileSync(changelogPath, 'utf8');

// Get current month header
const currentMonth = new Date().toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long'
});

// Check if current month section exists
const monthHeader = `## ${currentMonth}`;

if (content.includes(monthHeader)) {
  // Insert after month header
  content = content.replace(
    new RegExp(`(${monthHeader}\\n\\n)`),
    `$1${entry}`
  );
} else {
  // Add new month section after frontmatter
  const frontmatterEnd = content.indexOf('---', content.indexOf('---') + 1) + 3;
  content =
    content.slice(0, frontmatterEnd) +
    `\n\n${monthHeader}\n\n${entry}` +
    content.slice(frontmatterEnd);
}

// Write updated changelog
fs.writeFileSync(changelogPath, content);
console.log(`Updated ${changelogPath} with v${version}`);
