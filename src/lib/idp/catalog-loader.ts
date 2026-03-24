/**
 * Catalog loader — reads and parses YAML catalog entries from the IDP repo.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { findIdpDir } from './resolver.js';
import type { CatalogEntry, ScorecardDefinition, DependencyGraph } from './types.js';

/** Parse a YAML file using gray-matter's YAML engine */
function loadYaml<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    // gray-matter parses YAML frontmatter — wrap raw YAML so it treats entire file as frontmatter
    const { data } = matter(`---\n${raw}\n---`);
    return data as T;
  } catch {
    return null;
  }
}

/** Load all catalog entries from the IDP catalog/ directory */
export function loadCatalog(): CatalogEntry[] {
  const idpDir = findIdpDir();
  if (!idpDir) return [];

  const catalogDir = join(idpDir, 'catalog');
  if (!existsSync(catalogDir)) return [];

  const entries: CatalogEntry[] = [];
  for (const file of readdirSync(catalogDir).filter(f => f.endsWith('.yaml')).sort()) {
    const entry = loadYaml<CatalogEntry>(join(catalogDir, file));
    if (entry?.metadata?.name) {
      entries.push(entry);
    }
  }
  return entries;
}

/** Load a single catalog entry by service name */
export function loadService(name: string): CatalogEntry | null {
  const idpDir = findIdpDir();
  if (!idpDir) return null;

  const filePath = join(idpDir, 'catalog', `${name}.yaml`);
  return loadYaml<CatalogEntry>(filePath);
}

/** Load a scorecard definition by name */
export function loadScorecard(name: string): ScorecardDefinition | null {
  const idpDir = findIdpDir();
  if (!idpDir) return null;

  const filePath = join(idpDir, 'scorecards', `${name}.yaml`);
  return loadYaml<ScorecardDefinition>(filePath);
}

/** Load the dependency graph */
export function loadDependencyGraph(): DependencyGraph | null {
  const idpDir = findIdpDir();
  if (!idpDir) return null;

  return loadYaml<DependencyGraph>(join(idpDir, 'dependencies', 'graph.yaml'));
}
