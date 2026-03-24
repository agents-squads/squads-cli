/**
 * squads catalog — service catalog commands.
 *
 * squads catalog list              Show all services
 * squads catalog show <service>    Service details
 * squads catalog check <service>   Validate against scorecard
 */

import { Command } from 'commander';
import { loadCatalog, loadService, loadScorecard } from '../lib/idp/catalog-loader.js';
import { evaluateService } from '../lib/idp/scorecard-engine.js';
import { findIdpDir } from '../lib/idp/resolver.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

function noIdp(): boolean {
  if (!findIdpDir()) {
    writeLine(`  ${colors.red}IDP not found${RESET}`);
    writeLine(`  ${colors.dim}Set SQUADS_IDP_PATH or clone the idp repo as a sibling directory.${RESET}`);
    return true;
  }
  return false;
}

export function registerCatalogCommands(program: Command): void {
  const catalog = program
    .command('catalog')
    .description('Service catalog — browse, inspect, and validate services');

  // ── catalog list ──
  catalog
    .command('list')
    .description('List all services in the catalog')
    .option('--type <type>', 'Filter by type (product, domain)')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      if (noIdp()) return;

      const entries = loadCatalog();
      if (entries.length === 0) {
        writeLine('  No catalog entries found.');
        return;
      }

      const filtered = opts.type
        ? entries.filter(e => e.spec.type === opts.type)
        : entries;

      if (opts.json) {
        console.log(JSON.stringify(filtered.map(e => ({
          name: e.metadata.name,
          type: e.spec.type,
          stack: e.spec.stack,
          owner: e.metadata.owner,
          repo: e.metadata.repo,
        })), null, 2));
        return;
      }

      writeLine();
      writeLine(`  ${bold}Service Catalog${RESET} (${filtered.length} services)`);
      writeLine();

      // Group by type
      const products = filtered.filter(e => e.spec.type === 'product');
      const domains = filtered.filter(e => e.spec.type === 'domain');

      if (products.length > 0) {
        writeLine(`  ${colors.cyan}Product Services${RESET}`);
        writeLine();
        for (const e of products) {
          const ci = e.spec.ci.template ? `ci:${e.spec.ci.template}` : 'no-ci';
          const deploy = e.spec.deploy?.target || 'manual';
          writeLine(`  ${bold}${e.metadata.name}${RESET}  ${colors.dim}${e.spec.stack} | ${ci} | deploy:${deploy} | owner:${e.metadata.owner}${RESET}`);
          writeLine(`    ${colors.dim}${e.metadata.description}${RESET}`);
        }
        writeLine();
      }

      if (domains.length > 0) {
        writeLine(`  ${colors.cyan}Domain Repos${RESET}`);
        writeLine();
        for (const e of domains) {
          writeLine(`  ${e.metadata.name}  ${colors.dim}owner:${e.metadata.owner} | ${e.metadata.repo}${RESET}`);
        }
        writeLine();
      }
    });

  // ── catalog show <service> ──
  catalog
    .command('show <service>')
    .description('Show detailed info for a service')
    .option('--json', 'Output as JSON')
    .action((serviceName: string, opts) => {
      if (noIdp()) return;

      const entry = loadService(serviceName);
      if (!entry) {
        writeLine(`  ${colors.red}Service not found: ${serviceName}${RESET}`);
        writeLine(`  ${colors.dim}Run 'squads catalog list' to see available services.${RESET}`);
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }

      writeLine();
      writeLine(`  ${bold}${entry.metadata.name}${RESET}  ${colors.dim}${entry.spec.type}${RESET}`);
      writeLine(`  ${entry.metadata.description}`);
      writeLine();

      writeLine(`  ${colors.cyan}General${RESET}`);
      writeLine(`    Owner:      ${entry.metadata.owner}`);
      writeLine(`    Repo:       ${entry.metadata.repo}`);
      writeLine(`    Stack:      ${entry.spec.stack}${entry.spec.framework ? ` (${entry.spec.framework})` : ''}`);
      writeLine(`    Scorecard:  ${entry.spec.scorecard}`);
      writeLine(`    Tags:       ${entry.metadata.tags?.join(', ') || 'none'}`);
      writeLine();

      writeLine(`  ${colors.cyan}Branches${RESET}`);
      writeLine(`    Default:    ${entry.spec.branches.default}`);
      writeLine(`    Workflow:   ${entry.spec.branches.workflow}`);
      if (entry.spec.branches.development) {
        writeLine(`    Dev branch: ${entry.spec.branches.development}`);
      }
      writeLine();

      if (entry.spec.ci.template) {
        writeLine(`  ${colors.cyan}CI/CD${RESET}`);
        writeLine(`    Template:   ${entry.spec.ci.template}`);
        writeLine(`    Checks:     ${entry.spec.ci.required_checks.join(', ') || 'none'}`);
        if (entry.spec.ci.build_command) writeLine(`    Build:      ${entry.spec.ci.build_command}`);
        if (entry.spec.ci.test_command) writeLine(`    Test:       ${entry.spec.ci.test_command}`);
        writeLine();
      }

      if (entry.spec.deploy) {
        writeLine(`  ${colors.cyan}Deploy${RESET}`);
        writeLine(`    Target:     ${entry.spec.deploy.target}`);
        writeLine(`    Trigger:    ${entry.spec.deploy.trigger}`);
        if (entry.spec.deploy.environments) {
          for (const env of entry.spec.deploy.environments) {
            writeLine(`    ${env.name}: ${env.url}`);
          }
        }
        writeLine();
      }

      if (entry.spec.dependencies.runtime.length > 0) {
        writeLine(`  ${colors.cyan}Dependencies${RESET}`);
        for (const dep of entry.spec.dependencies.runtime) {
          const req = dep.required === false ? '(optional)' : '(required)';
          writeLine(`    → ${dep.service} ${dep.version || ''} ${req}`);
          writeLine(`      ${colors.dim}${dep.description}${RESET}`);
        }
        writeLine();
      }

      if (entry.spec.health.length > 0) {
        writeLine(`  ${colors.cyan}Health Endpoints${RESET}`);
        for (const h of entry.spec.health) {
          writeLine(`    ${h.name}: ${h.url}`);
        }
        writeLine();
      }
    });

  // ── catalog check <service> ──
  catalog
    .command('check [service]')
    .description('Run scorecard checks for a service (or all)')
    .option('--json', 'Output as JSON')
    .action((serviceName: string | undefined, opts) => {
      if (noIdp()) return;

      const entries = serviceName
        ? [loadService(serviceName)].filter(Boolean) as CatalogEntry[]
        : loadCatalog();

      if (entries.length === 0) {
        writeLine(`  ${colors.red}No services found${RESET}`);
        return;
      }

      const results = [];

      for (const entry of entries) {
        const scorecard = loadScorecard(entry.spec.scorecard);
        if (!scorecard) {
          writeLine(`  ${colors.dim}No scorecard '${entry.spec.scorecard}' for ${entry.metadata.name}${RESET}`);
          continue;
        }

        const result = evaluateService(entry, scorecard);
        results.push(result);

        if (!opts.json) {
          const gradeColor = result.grade === 'A' ? colors.green
            : result.grade === 'B' ? colors.cyan
              : result.grade === 'C' ? colors.yellow
                : colors.red;

          writeLine();
          writeLine(`  ${bold}${result.service}${RESET}  ${gradeColor}${result.grade}${RESET} (${result.score}/100)`);

          for (const check of result.checks) {
            const icon = check.passed ? `${colors.green}pass${RESET}` : `${colors.red}fail${RESET}`;
            writeLine(`    ${icon}  ${check.name} ${colors.dim}(${check.detail})${RESET}`);
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        writeLine();
      }
    });
}
