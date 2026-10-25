#!/usr/bin/env node
/**
 * Sync the event contract (schema + fixtures + validator) from a local
 * squads-engine checkout into this repo, and rewrite schema/SOURCE.json with
 * the engine commit and each copied file's sha256.
 *
 * The contract is engine-owned data: the schema files and the
 * validator under src/lib/event-schema-validate.ts are copied VERBATIM — a
 * local edit makes the contract test (test/event-schema-contract.test.ts)
 * fail on the hash check. Re-copy after an engine update; never hand-edit.
 *
 * Local only: reads from a sibling clone's git database, never the network.
 *
 * Usage:
 *   node scripts/sync-event-schema.mjs [engineDir]   # default: ../squads-engine
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(root, process.argv[2] ?? '../squads-engine');

/** Engine path → repo path. Identical names except the validator's new home. */
const FILES = [
  ['schema/exec-events.v2.json', 'schema/exec-events.v2.json'],
  ['schema/fixtures/events.jsonl', 'schema/fixtures/events.jsonl'],
  ['schema/fixtures/turns.jsonl', 'schema/fixtures/turns.jsonl'],
  ['schema/fixtures/invalid/bad-date-time.jsonl', 'schema/fixtures/invalid/bad-date-time.jsonl'],
  ['schema/fixtures/invalid/missing-required.jsonl', 'schema/fixtures/invalid/missing-required.jsonl'],
  ['schema/fixtures/invalid/unknown-event-type.jsonl', 'schema/fixtures/invalid/unknown-event-type.jsonl'],
  ['schema/fixtures/invalid/unknown-schema-version.jsonl', 'schema/fixtures/invalid/unknown-schema-version.jsonl'],
  ['src/schema/validate.ts', 'src/lib/event-schema-validate.ts'],
];

/**
 * The rev the contract is synced from: the engine checkout's HEAD when the
 * schema exists there, else its origin/develop (a checkout left behind still
 * syncs the current contract). Content reads through git — `cat-file blob` —
 * so everything copied is exactly what that rev holds, and SOURCE.json's
 * recorded commit proves it byte-for-byte.
 */
let rev = 'HEAD';
try {
  execFileSync('git', ['-C', engineDir, 'cat-file', '-e', `${rev}:${FILES[0][0]}`], { stdio: 'ignore' });
} catch {
  rev = 'origin/develop';
}
const engineCommit = execFileSync('git', ['-C', engineDir, 'rev-parse', rev], { encoding: 'utf8' }).trim();

for (const [src, dst] of FILES) {
  const data = execFileSync('git', ['-C', engineDir, 'cat-file', 'blob', `${rev}:${src}`], { maxBuffer: 16 * 1024 * 1024 });
  const target = join(root, dst);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

const files = {};
for (const [, dst] of FILES) {
  files[dst] = createHash('sha256').update(readFileSync(join(root, dst))).digest('hex');
}

rmSync(join(root, 'schema', 'SOURCE.json'), { force: true });
writeFileSync(
  join(root, 'schema', 'SOURCE.json'),
  JSON.stringify({ engine_commit: engineCommit, files }, null, 2) + '\n',
);
console.log(`synced ${FILES.length} files from squads-engine ${engineCommit} → schema/SOURCE.json rewritten`);
