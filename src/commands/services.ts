/**
 * squads services — manage Tier 2 local infrastructure.
 *
 * squads services up       Start Docker services, switch to local config
 * squads services down     Stop services, fall back to standalone
 * squads services status   Show running containers and health
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { detectTier } from '../lib/tier-detect.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

function exec(cmd: string, opts?: { cwd?: string }): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

function findComposeFile(): string | null {
  // Search for docker-compose in known locations
  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'agents-squads', 'engineering', 'docker', 'docker-compose.yml'),
    join(home, 'agents-squads', 'engineering', 'docker', 'docker-compose.yaml'),
    join(process.cwd(), '..', 'engineering', 'docker', 'docker-compose.yml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function dockerAvailable(): boolean {
  return exec('docker --version') !== null;
}

function dockerComposeAvailable(): boolean {
  return exec('docker compose version') !== null;
}

export function registerServicesCommands(program: Command): void {
  const services = program
    .command('services')
    .description('Manage Tier 2 local services (Postgres, Redis, API, Bridge)');

  // ── services up ──
  services
    .command('up')
    .description('Start local services (Docker required)')
    .option('--webhooks', 'Also start ngrok tunnel for GitHub webhooks')
    .option('--telemetry', 'Also start OpenTelemetry collector')
    .action(async (opts) => {
      if (!dockerAvailable()) {
        writeLine(`\n  ${colors.red}Docker not found.${RESET}`);
        writeLine(`  ${colors.dim}Install Docker Desktop: https://www.docker.com/products/docker-desktop${RESET}\n`);
        return;
      }
      if (!dockerComposeAvailable()) {
        writeLine(`\n  ${colors.red}Docker Compose not found.${RESET}\n`);
        return;
      }

      const composeFile = findComposeFile();
      if (!composeFile) {
        writeLine(`\n  ${colors.red}docker-compose.yml not found.${RESET}`);
        writeLine(`  ${colors.dim}Expected at: ~/agents-squads/engineering/docker/docker-compose.yml${RESET}\n`);
        return;
      }

      const composeDir = join(composeFile, '..');
      writeLine(`\n  ${bold}Starting Tier 2 services...${RESET}\n`);

      // Build profile args
      let profileArgs = '';
      if (opts.webhooks) profileArgs += ' --profile webhooks';
      if (opts.telemetry) profileArgs += ' --profile telemetry';

      try {
        writeLine(`  ${colors.dim}docker compose up -d${profileArgs}${RESET}`);
        execSync(`docker compose${profileArgs} up -d`, {
          cwd: composeDir,
          stdio: 'inherit',
          timeout: 120000,
        });

        writeLine();
        writeLine(`  ${colors.green}Services started.${RESET} Waiting for health checks...`);

        // Wait for API to be healthy
        let healthy = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const info = await detectTier();
          if (info.services.api) {
            healthy = true;
            break;
          }
        }

        if (healthy) {
          writeLine(`  ${colors.green}Tier 2 active.${RESET} All services healthy.\n`);
          writeLine(`  ${colors.dim}API:     http://localhost:8090${RESET}`);
          writeLine(`  ${colors.dim}Bridge:  http://localhost:8088${RESET}`);
          writeLine(`  ${colors.dim}Postgres: localhost:5432${RESET}`);
          writeLine(`  ${colors.dim}Redis:   localhost:6379${RESET}`);
        } else {
          writeLine(`  ${colors.yellow}Services started but API not healthy yet. Run 'squads services status' to check.${RESET}`);
        }
        writeLine();
      } catch (e) {
        writeLine(`\n  ${colors.red}Failed to start services: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
      }
    });

  // ── services down ──
  services
    .command('down')
    .description('Stop local services')
    .action(() => {
      const composeFile = findComposeFile();
      if (!composeFile) {
        writeLine(`\n  ${colors.dim}No docker-compose.yml found. Nothing to stop.${RESET}\n`);
        return;
      }

      const composeDir = join(composeFile, '..');
      writeLine(`\n  ${bold}Stopping Tier 2 services...${RESET}\n`);

      try {
        execSync('docker compose down', {
          cwd: composeDir,
          stdio: 'inherit',
          timeout: 60000,
        });
        writeLine(`\n  ${colors.dim}Services stopped. Falling back to Tier 1 (file-based).${RESET}\n`);
      } catch (e) {
        writeLine(`\n  ${colors.red}Failed to stop services: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
      }
    });

  // ── services status ──
  services
    .command('status')
    .description('Show running services and health')
    .action(async () => {
      const info = await detectTier();

      writeLine();
      writeLine(`  ${bold}Services${RESET} (Tier ${info.tier})\n`);

      const containers = exec('docker ps --filter name=squads --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}"');
      if (!containers) {
        writeLine(`  ${colors.dim}No Docker containers running.${RESET}\n`);
        return;
      }

      for (const line of containers.split('\n').filter(Boolean)) {
        const [name, status, ports] = line.split('\t');
        const healthy = status?.includes('healthy') || status?.includes('Up');
        const icon = healthy ? `${colors.green}up${RESET}` : `${colors.red}down${RESET}`;
        const portStr = ports ? `  ${colors.dim}${ports.split(',')[0]}${RESET}` : '';
        writeLine(`  ${icon}  ${bold}${name}${RESET}${portStr}`);
      }

      writeLine();

      // Show DB stats
      const jobCount = exec("docker exec squads-postgres psql -U squads -d squads -t -c 'SELECT count(*) FROM procrastinate_jobs;'");
      const execCount = exec("docker exec squads-postgres psql -U squads -d squads -t -c 'SELECT count(*) FROM agent_executions;'");

      if (jobCount || execCount) {
        writeLine(`  ${colors.cyan}Database${RESET}`);
        if (jobCount) writeLine(`    Procrastinate jobs: ${jobCount.trim()}`);
        if (execCount) writeLine(`    Agent executions:  ${execCount.trim()}`);
        writeLine();
      }
    });
}
