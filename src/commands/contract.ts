/**
 * `squads contract` — Agent Contracts: the governed, git-versioned definition of
 * what each agent may do (P0 of chief-cli-runtime, squads-cli#777).
 *
 * `squads contract validate` derives a contract for every agent (from SQUAD.md +
 * agent frontmatter + role defaults) and validates it. Non-zero exit on any
 * violation — so a repo of agent definitions (hq, or a customer's) can gate this
 * in CI / pre-commit. P0 changes no runtime behavior; this only *reads* and
 * *checks* definitions.
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { findSquadsDir, listSquads, loadSquad } from '../lib/squad-parser.js';
import {
  contractFromAgentFile,
  validateContract,
  type AgentContract,
  type ContractViolation,
} from '../lib/agent-contract.js';
import { validateSquadFrontmatter, type SquadSchemaResult } from '../lib/squad-schema.js';

interface Row {
  squad: string;
  agent: string;
  contract: AgentContract;
  violations: ContractViolation[];
}

export function registerContractCommand(program: Command): void {
  const contract = program
    .command('contract')
    .description('Define what each agent is allowed to do — permissions and guardrails, checked automatically');

  contract
    .command('validate')
    .description('Derive + validate every agent contract; non-zero exit on any violation')
    .option('--squad <name>', 'validate a single squad')
    .option('--json', 'machine-readable output')
    .action((opts: { squad?: string; json?: boolean }) => {
      const squadsDir = findSquadsDir();
      if (!squadsDir) {
        console.error('No .agents/squads directory found — run from a squads project.');
        process.exit(2);
      }
      const names = opts.squad ? [opts.squad] : listSquads(squadsDir);
      const rows: Row[] = [];
      // SQUAD.md against schemas/squad.schema.json — errors fail, legacy hints don't
      const squadChecks: Array<{ squad: string } & SquadSchemaResult> = [];
      for (const name of names) {
        const file = join(squadsDir, name, 'SQUAD.md');
        if (!existsSync(file)) continue;
        try {
          const fm = matter(readFileSync(file, 'utf-8')).data as Record<string, unknown>;
          squadChecks.push({ squad: name, ...validateSquadFrontmatter(fm) });
        } catch (e) {
          squadChecks.push({ squad: name, errors: [{ path: '(frontmatter)', message: `unreadable: ${e instanceof Error ? e.message : String(e)}` }], hints: [] });
        }
      }
      for (const name of names) {
        const squad = loadSquad(name);
        if (!squad) continue;
        const squadFile = join(squadsDir, squad.dir, 'SQUAD.md');
        for (const agent of squad.agents) {
          // loadSquad parses agents from SQUAD.md and leaves filePath unset;
          // resolve the agent definition file from the squad dir + agent name.
          const agentFile = agent.filePath ?? join(squadsDir, squad.dir, `${agent.name}.md`);
          if (!existsSync(agentFile)) continue;
          const c = contractFromAgentFile(agentFile, squad.dir, agent.name, squadFile);
          rows.push({ squad: squad.dir, agent: agent.name, contract: c, violations: validateContract(c) });
        }
      }

      const failed = rows.filter((r) => r.violations.length > 0);
      const squadsFailed = squadChecks.filter((c) => c.errors.length > 0);
      const hintCount = squadChecks.reduce((n, c) => n + c.hints.length, 0);

      if (opts.json) {
        console.log(JSON.stringify({ total: rows.length, failed: failed.length, rows, squads: squadChecks }, null, 2));
      } else {
        for (const c of squadsFailed) {
          console.log(`✗ ${c.squad}/SQUAD.md`);
          for (const e of c.errors) console.log(`    ${e.path}: ${e.message}`);
        }
        for (const r of failed) {
          console.log(`✗ ${r.squad}/${r.agent}`);
          for (const v of r.violations) console.log(`    ${v.field}: ${v.message}`);
        }
        const ok = rows.length - failed.length;
        const squadsOk = squadChecks.length - squadsFailed.length;
        console.log(`\n${squadsOk}/${squadChecks.length} SQUAD.md files match the schema${squadsFailed.length ? ` — ${squadsFailed.length} FAILED` : ''}` +
          (hintCount ? ` (${hintCount} format hint(s), --json for detail — the runtime still reads the current fields, keep them for now)` : '') + '.');
        console.log(`${ok}/${rows.length} agent contracts valid${failed.length ? ` — ${failed.length} FAILED` : ''}.`);
      }
      // exitCode, not exit(): exit() cuts off piped stdout (--json was truncated at 64 KB)
      process.exitCode = failed.length > 0 || squadsFailed.length > 0 ? 1 : 0;
    });
}
