/**
 * squads services — manage local infrastructure services.
 *
 * squads services up       Start Docker services
 * squads services down     Stop Docker services
 * squads services status   Show running containers and health
 *
 * Discovers docker-compose.yml from the user's project root or
 * a configurable SQUADS_COMPOSE_FILE environment variable.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { detectTier } from '../lib/tier-detect.js';
import { findProjectRoot } from '../lib/squad-parser.js';
import { loadProjectConfig } from '../lib/config.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

function exec(cmd: string, opts?: { cwd?: string }): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

function findComposeFile(): string | null {
  // 1. Explicit env var (highest priority, checked live — not cached)
  if (process.env.SQUADS_COMPOSE_FILE && existsSync(process.env.SQUADS_COMPOSE_FILE)) {
    return process.env.SQUADS_COMPOSE_FILE;
  }

  // 2. Project config file (.squads/config.yml)
  const configCompose = loadProjectConfig().compose_file;
  if (configCompose && !process.env.SQUADS_COMPOSE_FILE && existsSync(configCompose)) {
    return configCompose;
  }

  // 3. Search from project root upward
  const projectRoot = findProjectRoot();
  const searchRoots = [projectRoot, process.cwd()].filter(Boolean) as string[];

  for (const root of searchRoots) {
    const candidates = [
      join(root, 'docker-compose.yml'),
      join(root, 'docker-compose.yaml'),
      join(root, 'docker', 'docker-compose.yml'),
      join(root, 'docker', 'docker-compose.yaml'),
      join(root, 'infra', 'docker-compose.yml'),
      join(root, 'infra', 'docker-compose.yaml'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function resolveComposeFile(filePath?: string): string | null {
  if (filePath) {
    if (!existsSync(filePath)) {
      writeLine(`\n  ${colors.red}File not found: ${filePath}${RESET}\n`);
      return null;
    }
    return filePath;
  }
  return findComposeFile();
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
    .description('Manage local Docker services for your project')
    .action(() => { services.outputHelp(); });

  // ── services up ──
  services
    .command('up')
    .description('Start local services (Docker required)')
    .option('--file <path>', 'Path to docker-compose.yml')
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

      const composeFile = resolveComposeFile(opts.file);
      if (!composeFile) {
        if (!opts.file) {
          writeLine(`\n  ${colors.red}docker-compose.yml not found.${RESET}`);
          writeLine(`  ${colors.dim}Searched: project root, ./docker/, ./infra/${RESET}`);
          writeLine(`  ${colors.dim}Or set SQUADS_COMPOSE_FILE env var, or use --file <path>${RESET}\n`);
        }
        return;
      }

      const composeDir = join(composeFile, '..');
      writeLine(`\n  ${bold}Starting services...${RESET}`);
      writeLine(`  ${colors.dim}${composeFile}${RESET}\n`);

      try {
        execSync(`docker compose up -d`, {
          cwd: composeDir,
          stdio: 'inherit',
          timeout: 120000,
        });

        writeLine();
        writeLine(`  ${colors.green}Services started.${RESET} Waiting for health checks...`);

        // Wait for services to be healthy
        let healthy = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const states = exec('docker compose ps --format "{{.State}}"', { cwd: composeDir });
          if (!states) continue;
          const stateList = states.split('\n').filter(Boolean);
          const allRunning = stateList.length > 0 && stateList.every(s => s === 'running' || s === 'healthy');
          if (allRunning) {
            healthy = true;
            break;
          }
        }

        if (healthy) {
          writeLine(`  ${colors.green}All services healthy.${RESET}`);
        } else {
          writeLine(`  ${colors.yellow}Some services still starting. Run 'squads services status' to check.${RESET}`);
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
    .option('--file <path>', 'Path to docker-compose.yml')
    .action((opts) => {
      const composeFile = resolveComposeFile(opts.file);
      if (!composeFile) {
        if (!opts.file) {
          writeLine(`\n  ${colors.dim}No docker-compose.yml found. Nothing to stop.${RESET}\n`);
        }
        return;
      }

      const composeDir = join(composeFile, '..');
      writeLine(`\n  ${bold}Stopping services...${RESET}\n`);

      try {
        execSync('docker compose down', {
          cwd: composeDir,
          stdio: 'inherit',
          timeout: 60000,
        });
        writeLine(`\n  ${colors.dim}Services stopped.${RESET}\n`);
      } catch (e) {
        writeLine(`\n  ${colors.red}Failed to stop services: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
      }
    });

  // ── services status ──
  services
    .command('status')
    .description('Show running Docker containers and health')
    .option('--file <path>', 'Path to docker-compose.yml')
    .action(async (opts) => {
      if (!dockerAvailable()) {
        writeLine(`\n  ${colors.dim}Docker not installed.${RESET}\n`);
        return;
      }

      const info = await detectTier();
      writeLine();
      writeLine(`  ${bold}Services${RESET} (Tier ${info.tier})\n`);

      const composeFile = resolveComposeFile(opts.file);
      if (composeFile) {
        const composeDir = join(composeFile, '..');
        const containers = exec('docker compose ps --format "{{.Name}}\\t{{.Status}}\\t{{.Ports}}"', { cwd: composeDir });
        if (containers) {
          for (const line of containers.split('\n').filter(Boolean)) {
            const [name, status, ports] = line.split('\t');
            const healthy = status?.includes('healthy') || status?.includes('Up') || status?.includes('running');
            const icon = healthy ? `${colors.green}up${RESET}` : `${colors.red}down${RESET}`;
            const portStr = ports ? `  ${colors.dim}${ports.split(',')[0]}${RESET}` : '';
            writeLine(`  ${icon}  ${bold}${name}${RESET}${portStr}`);
          }
          writeLine();
          return;
        }
      }

      // Fallback: show any running Docker containers
      const anyContainers = exec('docker ps --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}"');
      if (!anyContainers) {
        writeLine(`  ${colors.dim}No Docker containers running.${RESET}\n`);
        return;
      }

      for (const line of anyContainers.split('\n').filter(Boolean)) {
        const [name, status, ports] = line.split('\t');
        const healthy = status?.includes('healthy') || status?.includes('Up') || status?.includes('running');
        const icon = healthy ? `${colors.green}up${RESET}` : `${colors.red}down${RESET}`;
        const portStr = ports ? `  ${colors.dim}${ports.split(',')[0]}${RESET}` : '';
        writeLine(`  ${icon}  ${bold}${name}${RESET}${portStr}`);
      }
      writeLine();
    });
}
