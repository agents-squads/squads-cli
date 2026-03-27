/**
 * squads tier — show active infrastructure tier and available services.
 */

import { Command } from 'commander';
import { detectTier } from '../lib/tier-detect.js';
import { queryExecutions } from '../lib/observability.js';
import { loadCatalog } from '../lib/idp/catalog-loader.js';
import { findIdpDir } from '../lib/idp/resolver.js';
import { findMemoryDir } from '../lib/memory.js';
import { findSquadsDir } from '../lib/squad-parser.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';
import { existsSync, readdirSync } from 'fs';

export function registerTierCommand(program: Command): void {
  program
    .command('tier')
    .description('Show active infrastructure tier and available services')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const info = await detectTier();

      if (opts.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }

      writeLine();
      if (info.tier === 1) {
        writeLine(`  ${bold}Tier 1${RESET} ${colors.dim}(file-based)${RESET}`);
      } else {
        writeLine(`  ${bold}Tier 2${RESET} ${colors.green}(local services)${RESET}`);
      }
      writeLine();

      // Data sources
      writeLine(`  ${colors.cyan}Data${RESET}`);
      const executions = queryExecutions({ limit: 1000 });
      writeLine(`    Observability:  ${executions.length} executions logged`);

      const squadsDir = findSquadsDir();
      if (squadsDir) {
        const squads = readdirSync(squadsDir).filter(f => {
          try { return existsSync(`${squadsDir}/${f}/SQUAD.md`); } catch { return false; }
        });
        writeLine(`    Squads:         ${squads.length} defined`);
      }

      const memoryDir = findMemoryDir();
      if (memoryDir) {
        writeLine(`    Memory:         ${memoryDir}`);
      }

      const idpDir = findIdpDir();
      if (idpDir) {
        const catalog = loadCatalog();
        writeLine(`    IDP:            ${catalog.length} catalog entries`);
      } else {
        writeLine(`    IDP:            not configured`);
      }
      writeLine();

      // Services
      writeLine(`  ${colors.cyan}Services${RESET}`);
      const svc = info.services;
      const icon = (ok: boolean) => ok ? `${colors.green}up${RESET}` : `${colors.dim}—${RESET}`;
      writeLine(`    API:       ${icon(svc.api)}${svc.api ? `  ${info.urls.api}` : ''}`);
      writeLine(`    Bridge:    ${icon(svc.bridge)}${svc.bridge ? `  ${info.urls.bridge}` : ''}`);
      writeLine(`    Postgres:  ${icon(svc.postgres)}`);
      writeLine(`    Redis:     ${icon(svc.redis)}`);
      writeLine();

      if (info.tier === 1) {
        writeLine(`  ${colors.dim}Upgrade: run 'squads services up' for Tier 2${RESET}`);
        writeLine(`  ${colors.dim}(smart triggers, Postgres, webhooks, budget enforcement)${RESET}`);
      } else {
        writeLine(`  ${colors.dim}All local services healthy. Data syncs to Postgres.${RESET}`);
      }
      writeLine();
    });
}
