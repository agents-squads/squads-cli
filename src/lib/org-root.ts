/**
 * Org root discovery (#1277).
 *
 * A workspace ("org root") is one directory holding many repos — product,
 * domains, clients. Tools find it from disk, never from hand-kept lists:
 *
 *   1. `SQUADS_ORG_ROOT` env override (explicit wins).
 *   2. Walk up from the working directory to the directory that contains the
 *      control repo (name from `SQUADS_ORG_CONTROL_REPO`, default `hq`).
 *   3. Fallback: the parent of the nearest squads project root (a directory
 *      holding `.agents/`) — repos are siblings under one parent.
 *
 * No absolute paths are ever assumed; everything is discovered at runtime.
 */

import { readdirSync, realpathSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';

export type OrgRootSource = 'env' | 'control-repo' | 'squads-project';

export interface OrgRoot {
  /** Absolute path of the org root directory. */
  root: string;
  /** How the root was found. */
  source: OrgRootSource;
  /** Control repo directory name when known (default `hq`). */
  controlRepo: string;
}

const DEFAULT_CONTROL_REPO = 'hq';
const MAX_WALK_UP = 10;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function controlRepoName(): string {
  const name = process.env.SQUADS_ORG_CONTROL_REPO?.trim();
  return name || DEFAULT_CONTROL_REPO;
}

/** Canonical path (resolves symlinks such as macOS /var → /private/var) so callers compare like with like. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Discover the org root. Returns null when no workspace structure is found
 * (no env override, no control repo above, no squads project above).
 * Throws when SQUADS_ORG_ROOT is set but does not point at a directory.
 */
export function findOrgRoot(startDir: string = process.cwd()): OrgRoot | null {
  const envRoot = process.env.SQUADS_ORG_ROOT?.trim();
  const control = controlRepoName();
  if (envRoot) {
    // Explicit wins, even when wrong: silently walking up from cwd would audit a different tree.
    if (!isDir(envRoot)) throw new Error(`SQUADS_ORG_ROOT is set but is not a directory: ${envRoot}`);
    return { root: canonical(envRoot), source: 'env', controlRepo: control };
  }

  let dir = resolve(startDir);
  let squadsProjectRoot: string | null = null;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (isDir(join(dir, control))) {
      return { root: canonical(dir), source: 'control-repo', controlRepo: control };
    }
    if (!squadsProjectRoot && isDir(join(dir, '.agents'))) {
      squadsProjectRoot = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (squadsProjectRoot) {
    // Repos are siblings under the same parent directory.
    return { root: canonical(dirname(squadsProjectRoot)), source: 'squads-project', controlRepo: control };
  }
  return null;
}

/**
 * List candidate units of an org root: immediate subdirectories, hidden
 * entries excluded. Sorted by name for stable output.
 */
export function listOrgUnits(orgRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(orgRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('.') && isDir(join(orgRoot, name)))
    .sort((a, b) => a.localeCompare(b));
}
