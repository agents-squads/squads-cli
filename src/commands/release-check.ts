/**
 * squads release — release pre-check and status.
 *
 * squads release pre-check <service>   Validate dependencies before deploy
 */

import { Command } from 'commander';
import { loadService, loadDependencyGraph } from '../lib/idp/catalog-loader.js';
import { findIdpDir } from '../lib/idp/resolver.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

async function checkHealth(url: string, expect: number): Promise<{ ok: boolean; status: number | string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return { ok: response.status === expect, status: response.status };
  } catch (e) {
    return { ok: false, status: e instanceof Error ? e.message : 'unreachable' };
  }
}

export function registerReleaseCommands(program: Command): void {
  const release = program
    .command('release')
    .description('Release management — pre-deploy checks and status');

  release
    .command('pre-check <service>')
    .description('Validate dependencies and health before deploying a service')
    .option('--skip-health', 'Skip health endpoint checks')
    .action(async (serviceName: string, opts) => {
      const idpDir = findIdpDir();
      if (!idpDir) {
        writeLine(`  ${colors.red}IDP not found${RESET}`);
        return;
      }

      const service = loadService(serviceName);
      if (!service) {
        writeLine(`  ${colors.red}Service not found: ${serviceName}${RESET}`);
        return;
      }

      const graph = loadDependencyGraph();
      const deps = service.spec.dependencies.runtime;

      writeLine();
      writeLine(`  ${bold}Release Pre-Check: ${serviceName}${RESET}`);
      writeLine();

      let allGreen = true;

      // Check dependencies
      if (deps.length === 0) {
        writeLine(`  ${colors.green}pass${RESET}  No runtime dependencies`);
      } else {
        writeLine(`  ${colors.cyan}Dependencies${RESET}`);
        for (const dep of deps) {
          const depService = loadService(dep.service);
          const req = dep.required !== false;

          if (!depService) {
            if (dep.type === 'infrastructure') {
              writeLine(`    ${colors.dim}skip${RESET}  ${dep.service} (infrastructure — not in catalog)`);
              continue;
            }
            if (req) {
              writeLine(`    ${colors.red}fail${RESET}  ${dep.service} — not found in catalog`);
              allGreen = false;
            } else {
              writeLine(`    ${colors.yellow}warn${RESET}  ${dep.service} — not in catalog (optional)`);
            }
            continue;
          }

          // Check health of dependency
          if (!opts.skipHealth && depService.spec.health.length > 0) {
            for (const h of depService.spec.health) {
              const result = await checkHealth(h.url, h.expect);
              if (result.ok) {
                writeLine(`    ${colors.green}pass${RESET}  ${dep.service}/${h.name} — ${result.status}`);
              } else if (req) {
                writeLine(`    ${colors.red}fail${RESET}  ${dep.service}/${h.name} — ${result.status}`);
                allGreen = false;
              } else {
                writeLine(`    ${colors.yellow}warn${RESET}  ${dep.service}/${h.name} — ${result.status} (optional)`);
              }
            }
          } else {
            writeLine(`    ${colors.dim}skip${RESET}  ${dep.service} health check (${opts.skipHealth ? 'skipped' : 'no endpoints'})`);
          }
        }
      }

      writeLine();

      // Check deploy order from graph
      if (graph) {
        const order = graph.deploy_order;
        let servicePhase = -1;
        for (let i = 0; i < order.length; i++) {
          if (order[i].includes(serviceName)) {
            servicePhase = i;
            break;
          }
        }

        if (servicePhase >= 0) {
          writeLine(`  ${colors.cyan}Deploy Order${RESET}`);
          for (let i = 0; i < order.length; i++) {
            const marker = i === servicePhase ? `${colors.green}→${RESET}` : ' ';
            const phase = order[i].join(', ');
            writeLine(`  ${marker} Phase ${i + 1}: ${i === servicePhase ? bold : colors.dim}${phase}${RESET}`);
          }
          writeLine();
        }
      }

      // Self health check
      if (!opts.skipHealth && service.spec.health.length > 0) {
        writeLine(`  ${colors.cyan}Self Health${RESET}`);
        for (const h of service.spec.health) {
          const result = await checkHealth(h.url, h.expect);
          if (result.ok) {
            writeLine(`    ${colors.green}pass${RESET}  ${h.name} — ${result.status}`);
          } else {
            writeLine(`    ${colors.yellow}warn${RESET}  ${h.name} — ${result.status}`);
          }
        }
        writeLine();
      }

      // Summary
      if (allGreen) {
        writeLine(`  ${colors.green}All checks passed — safe to deploy ${serviceName}${RESET}`);
      } else {
        writeLine(`  ${colors.red}Pre-check failed — fix issues before deploying ${serviceName}${RESET}`);
      }
      writeLine();
    });
}
