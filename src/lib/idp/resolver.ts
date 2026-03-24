/**
 * IDP directory resolver — finds the IDP repo/directory.
 *
 * Resolution order:
 * 1. SQUADS_IDP_PATH env var (explicit override)
 * 2. .agents/idp/ in project root (co-located)
 * 3. ../idp/ sibling repo (our setup)
 * 4. ~/agents-squads/idp/ (absolute fallback)
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { findProjectRoot } from '../squad-parser.js';

export function findIdpDir(): string | null {
  // 1. Explicit env var
  const envPath = process.env.SQUADS_IDP_PATH;
  if (envPath && existsSync(envPath)) {
    return resolve(envPath);
  }

  // 2. Co-located in project
  const projectRoot = findProjectRoot();
  if (projectRoot) {
    const colocated = join(projectRoot, '.agents', 'idp');
    if (existsSync(join(colocated, 'catalog'))) {
      return colocated;
    }

    // 3. Sibling repo
    const sibling = join(projectRoot, '..', 'idp');
    if (existsSync(join(sibling, 'catalog'))) {
      return resolve(sibling);
    }
  }

  // 4. Absolute fallback
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const absolute = join(home, 'agents-squads', 'idp');
  if (existsSync(join(absolute, 'catalog'))) {
    return absolute;
  }

  return null;
}
