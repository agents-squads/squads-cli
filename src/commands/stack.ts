import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
  box,
  padEnd,
} from '../lib/terminal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface StackConfig {
  SQUADS_DATABASE_URL: string;
  SQUADS_BRIDGE_URL: string;
  LANGFUSE_HOST: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  REDIS_URL: string;
}

interface ContainerStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  port?: string;
}

const DEFAULT_CONFIG: StackConfig = {
  SQUADS_DATABASE_URL: 'postgresql://squads:squads@localhost:5433/squads',
  SQUADS_BRIDGE_URL: 'http://localhost:8088',
  LANGFUSE_HOST: 'http://localhost:3100',
  LANGFUSE_PUBLIC_KEY: '',
  LANGFUSE_SECRET_KEY: '',
  REDIS_URL: 'redis://localhost:6379',
};

const CONFIG_PATH = join(homedir(), '.squadsrc');
const SQUADS_DATA_DIR = join(homedir(), '.squads');

/**
 * Service requirements and setup guidance
 */
interface ServiceInfo {
  name: string;
  description: string;
  required: boolean;
  healthUrl?: string;
  envVars: string[];
  setupGuide: string[];
}

const SERVICES: Record<string, ServiceInfo> = {
  bridge: {
    name: 'Bridge API',
    description: 'Captures conversations and telemetry',
    required: true,
    healthUrl: 'http://localhost:8088/health',
    envVars: ['SQUADS_BRIDGE_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose up -d bridge',
    ],
  },
  postgres: {
    name: 'PostgreSQL',
    description: 'Stores conversations and telemetry data',
    required: true,
    envVars: ['SQUADS_DATABASE_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose up -d postgres',
    ],
  },
  mem0: {
    name: 'Mem0 (Engram)',
    description: 'Extracts and stores memories from conversations',
    required: false,
    healthUrl: 'http://localhost:8000/health',
    envVars: ['MEM0_API_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose -f docker-compose.engram.yml up -d mem0',
      '',
      'Mem0 requires an LLM provider. Configure in docker/.env:',
      '  LLM_PROVIDER=ollama   # For local (free)',
      '  LLM_PROVIDER=openai   # Requires OPENAI_API_KEY',
    ],
  },
  langfuse: {
    name: 'Langfuse',
    description: 'Telemetry dashboard and cost tracking',
    required: false,
    healthUrl: 'http://localhost:3100/api/public/health',
    envVars: ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
    setupGuide: [
      'Run: squads stack up',
      'Then get API keys from: http://localhost:3100',
      '  1. Create account / login',
      '  2. Create project',
      '  3. Copy API keys to docker/.env',
    ],
  },
  redis: {
    name: 'Redis',
    description: 'Caching and rate limiting',
    required: false,
    envVars: ['REDIS_URL'],
    setupGuide: [
      'Run: squads stack up',
    ],
  },
};

/**
 * Check if a service is available and show guidance if not
 */
export async function checkServiceAvailable(
  serviceName: keyof typeof SERVICES,
  showGuidance = true
): Promise<boolean> {
  const service = SERVICES[serviceName];
  if (!service) return false;

  // Check container
  const containerName = `squads-${serviceName === 'mem0' ? 'mem0' : serviceName}`;
  const status = getContainerStatus(containerName);

  if (!status.running) {
    if (showGuidance) {
      showServiceSetupGuide(serviceName, 'not running');
    }
    return false;
  }

  // Check HTTP health if available
  if (service.healthUrl) {
    const healthy = await checkService(service.healthUrl);
    if (!healthy) {
      if (showGuidance) {
        showServiceSetupGuide(serviceName, 'not responding');
      }
      return false;
    }
  }

  return true;
}

/**
 * Show setup guide for a service
 */
export function showServiceSetupGuide(
  serviceName: keyof typeof SERVICES,
  issue: string
): void {
  const service = SERVICES[serviceName];
  if (!service) return;

  writeLine();
  writeLine(`  ${colors.yellow}${icons.warning}${RESET} ${bold}${service.name}${RESET} is ${issue}`);
  writeLine(`  ${colors.dim}${service.description}${RESET}`);
  writeLine();

  writeLine(`  ${bold}To fix:${RESET}`);
  for (const step of service.setupGuide) {
    if (step === '') {
      writeLine();
    } else {
      writeLine(`  ${colors.dim}${step}${RESET}`);
    }
  }

  if (service.envVars.length > 0) {
    writeLine();
    writeLine(`  ${bold}Environment variables:${RESET}`);
    for (const envVar of service.envVars) {
      const value = process.env[envVar];
      const status = value ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
      writeLine(`  ${status} ${colors.cyan}${envVar}${RESET}${value ? ` = ${colors.dim}${value}${RESET}` : ''}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}Full setup: squads stack init${RESET}`);
  writeLine();
}

/**
 * Prompt user for input
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ` [${defaultValue}]` : '';

  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt yes/no
 */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(`${question} ${suffix}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

/**
 * Find package docker directory (from npm package or local dev)
 */
function findPackageDockerDir(): string | null {
  const candidates = [
    // From npm package (relative to dist/commands/stack.js)
    join(__dirname, '..', '..', 'docker'),
    // Local development
    join(process.cwd(), 'docker'),
    join(process.cwd(), '..', 'squads-cli', 'docker'),
    join(homedir(), 'agents-squads', 'squads-cli', 'docker'),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }

  return null;
}

/**
 * Load config from ~/.squadsrc
 */
export function loadStackConfig(): Partial<StackConfig> | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const config: Partial<StackConfig> = {};

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^export\s+(\w+)=["']?([^"'\n]*)["']?$/);
      if (match) {
        const [, key, value] = match;
        if (key in DEFAULT_CONFIG) {
          (config as Record<string, string>)[key] = value;
        }
      }
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Save config to ~/.squadsrc
 */
function saveStackConfig(config: StackConfig): void {
  const lines = [
    '# Squads CLI Local Stack Configuration',
    '# Generated by: squads stack init',
    `# Date: ${new Date().toISOString().split('T')[0]}`,
    '',
    '# Database',
    `export SQUADS_DATABASE_URL="${config.SQUADS_DATABASE_URL}"`,
    '',
    '# Bridge API',
    `export SQUADS_BRIDGE_URL="${config.SQUADS_BRIDGE_URL}"`,
    '',
    '# Langfuse',
    `export LANGFUSE_HOST="${config.LANGFUSE_HOST}"`,
    `export LANGFUSE_PUBLIC_KEY="${config.LANGFUSE_PUBLIC_KEY}"`,
    `export LANGFUSE_SECRET_KEY="${config.LANGFUSE_SECRET_KEY}"`,
    '',
    '# Redis',
    `export REDIS_URL="${config.REDIS_URL}"`,
    '',
    '# To activate: source ~/.squadsrc',
    '',
  ];

  writeFileSync(CONFIG_PATH, lines.join('\n'));
}

/**
 * Apply config to current process environment
 */
export function applyStackConfig(): void {
  const config = loadStackConfig();
  if (!config) return;

  for (const [key, value] of Object.entries(config)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Check if Docker is running
 */
function isDockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get container status
 */
function getContainerStatus(name: string): ContainerStatus {
  try {
    // First check if container is running
    const runningOutput = execSync(
      `docker inspect ${name} --format '{{.State.Running}}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();

    const running = runningOutput === 'true';

    if (!running) {
      return { name, running: false, healthy: false };
    }

    // Get port info
    let port: string | undefined;
    try {
      const portOutput = execSync(
        `docker inspect ${name} --format '{{range .NetworkSettings.Ports}}{{range .}}{{.HostPort}}{{end}}{{end}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
      port = portOutput || undefined;
    } catch {
      // Ignore port errors
    }

    // Check health status (may not exist for all containers)
    let healthy = true; // Default to healthy if running but no health check
    try {
      const healthOutput = execSync(
        `docker inspect ${name} --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (healthOutput === 'healthy' || healthOutput === 'none') {
        healthy = true;
      } else if (healthOutput === 'starting') {
        healthy = false; // Starting means not yet healthy
      } else {
        healthy = false; // unhealthy or other states
      }
    } catch {
      // If health check fails, assume healthy if running
      healthy = true;
    }

    return { name, running, healthy, port };
  } catch {
    return { name, running: false, healthy: false };
  }
}

/**
 * Check service connectivity
 */
async function checkService(url: string, timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get Langfuse API keys from the docker .env file
 */
function getLangfuseKeysFromDockerEnv(): { publicKey: string; secretKey: string } | null {
  const envPaths = [
    join(process.cwd(), 'docker', '.env'),
    join(process.cwd(), '..', 'squads-cli', 'docker', '.env'),
    join(homedir(), 'agents-squads', 'squads-cli', 'docker', '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      const publicMatch = content.match(/LANGFUSE_PUBLIC_KEY=(\S+)/);
      const secretMatch = content.match(/LANGFUSE_SECRET_KEY=(\S+)/);

      if (publicMatch && secretMatch) {
        return {
          publicKey: publicMatch[1],
          secretKey: secretMatch[1],
        };
      }
    }
  }

  return null;
}

/**
 * Find docker-compose directory
 */
function findDockerComposeDir(): string | null {
  const candidates = [
    join(process.cwd(), 'docker'),
    join(process.cwd(), '..', 'squads-cli', 'docker'),
    join(homedir(), 'agents-squads', 'squads-cli', 'docker'),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }

  return null;
}

/**
 * squads stack init - setup wizard for local stack
 */
export async function stackInitCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}stack init${RESET}`);
  writeLine();
  writeLine(`  ${bold}Local Infrastructure Setup Wizard${RESET}`);
  writeLine(`  ${colors.dim}This will configure Docker services for conversation capture,${RESET}`);
  writeLine(`  ${colors.dim}memory extraction, and telemetry.${RESET}`);
  writeLine();

  // Step 1: Check Docker
  writeLine(`  ${bold}Step 1: Docker${RESET}`);
  if (!isDockerRunning()) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Docker is not running`);
    writeLine();
    writeLine(`  ${colors.dim}Please start Docker Desktop and run this command again.${RESET}`);
    writeLine();
    return;
  }
  writeLine(`  ${colors.green}${icons.success}${RESET} Docker is running`);
  writeLine();

  // Step 2: Find or setup docker compose files
  writeLine(`  ${bold}Step 2: Docker Compose Files${RESET}`);

  let composeDir = findPackageDockerDir();
  const targetDir = join(SQUADS_DATA_DIR, 'docker');

  if (!composeDir) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Docker compose files not found`);
    writeLine(`  ${colors.dim}This shouldn't happen if you installed via npm.${RESET}`);
    writeLine(`  ${colors.dim}Try reinstalling: npm install -g squads-cli${RESET}`);
    writeLine();
    return;
  }

  // Copy to ~/.squads/docker if not already there
  if (composeDir !== targetDir && !existsSync(targetDir)) {
    writeLine(`  ${colors.cyan}${icons.progress}${RESET} Copying docker files to ${colors.dim}~/.squads/docker${RESET}`);
    try {
      mkdirSync(SQUADS_DATA_DIR, { recursive: true });
      mkdirSync(targetDir, { recursive: true });

      // Copy essential files
      const filesToCopy = [
        'docker-compose.yml',
        'docker-compose.engram.yml',
        '.env.example',
      ];

      for (const file of filesToCopy) {
        const src = join(composeDir, file);
        const dst = join(targetDir, file);
        if (existsSync(src)) {
          copyFileSync(src, dst);
        }
      }

      composeDir = targetDir;
      writeLine(`  ${colors.green}${icons.success}${RESET} Files copied`);
    } catch {
      writeLine(`  ${colors.yellow}${icons.warning}${RESET} Could not copy files, using source location`);
    }
  } else if (existsSync(targetDir)) {
    composeDir = targetDir;
    writeLine(`  ${colors.green}${icons.success}${RESET} Using ${colors.dim}~/.squads/docker${RESET}`);
  } else {
    writeLine(`  ${colors.green}${icons.success}${RESET} Using ${colors.dim}${composeDir}${RESET}`);
  }
  writeLine();

  // Step 3: Configure .env
  writeLine(`  ${bold}Step 3: Environment Configuration${RESET}`);

  const envPath = join(composeDir, '.env');
  const envExamplePath = join(composeDir, '.env.example');

  if (!existsSync(envPath)) {
    if (existsSync(envExamplePath)) {
      copyFileSync(envExamplePath, envPath);
      writeLine(`  ${colors.cyan}${icons.progress}${RESET} Created .env from template`);
    } else {
      // Create minimal .env
      const minimalEnv = `# Squads Local Stack Configuration
# Generated by: squads stack init

# Langfuse API Keys (get from http://localhost:3100 after first run)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=http://langfuse:3000

# Mem0/Engram LLM Provider
# Options: ollama (free, local), openai (requires API key)
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_LLM_MODEL=qwen3:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text:latest

# For OpenAI (if LLM_PROVIDER=openai)
# OPENAI_API_KEY=sk-...

# Ports (defaults)
POSTGRES_PORT=5433
REDIS_PORT=6379
LANGFUSE_PORT=3100
OTEL_PORT=4318
BRIDGE_PORT=8088
`;
      writeFileSync(envPath, minimalEnv);
      writeLine(`  ${colors.cyan}${icons.progress}${RESET} Created default .env`);
    }
  } else {
    writeLine(`  ${colors.green}${icons.success}${RESET} .env exists`);
  }

  // Check for required secrets
  const envContent = readFileSync(envPath, 'utf-8');
  const missingSecrets: string[] = [];

  // Check LLM provider config
  const llmProvider = envContent.match(/LLM_PROVIDER=(\w+)/)?.[1] || 'ollama';

  if (llmProvider === 'openai') {
    if (!envContent.match(/OPENAI_API_KEY=\S+/)) {
      missingSecrets.push('OPENAI_API_KEY');
    }
  }

  if (missingSecrets.length > 0) {
    writeLine();
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Missing secrets in .env:`);
    for (const secret of missingSecrets) {
      writeLine(`    ${colors.red}•${RESET} ${secret}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}Edit: ${envPath}${RESET}`);
  }
  writeLine();

  // Step 4: Start containers
  writeLine(`  ${bold}Step 4: Start Services${RESET}`);

  const containers = [
    { name: 'squads-postgres', required: true },
    { name: 'squads-redis', required: true },
    { name: 'squads-bridge', required: true },
    { name: 'squads-langfuse', required: false },
    { name: 'squads-otel-collector', required: false },
    { name: 'squads-mem0', required: false },
  ];

  const statuses = containers.map(c => ({ ...c, ...getContainerStatus(c.name) }));
  const requiredNotRunning = statuses.filter(s => s.required && !s.running);

  for (const status of statuses) {
    const icon = status.running
      ? status.healthy
        ? `${colors.green}●${RESET}`
        : `${colors.yellow}●${RESET}`
      : `${colors.red}○${RESET}`;
    const suffix = status.required ? '' : `${colors.dim}(optional)${RESET}`;
    writeLine(`  ${icon} ${status.name} ${suffix}`);
  }
  writeLine();

  if (requiredNotRunning.length > 0) {
    const shouldStart = await confirm('Start required services now?');

    if (shouldStart) {
      writeLine();
      writeLine(`  ${colors.cyan}${icons.progress}${RESET} Starting containers...`);

      try {
        execSync('docker compose up -d', {
          cwd: composeDir,
          stdio: 'inherit',
        });

        // Wait for services to be healthy
        writeLine(`  ${colors.cyan}${icons.progress}${RESET} Waiting for services to be ready...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        writeLine(`  ${colors.green}${icons.success}${RESET} Services started`);
      } catch {
        writeLine(`  ${colors.red}${icons.error}${RESET} Failed to start services`);
        writeLine(`  ${colors.dim}Try manually: cd ${composeDir} && docker compose up -d${RESET}`);
      }
    }
    writeLine();
  }

  // Step 5: Get Langfuse keys
  writeLine(`  ${bold}Step 5: Langfuse API Keys${RESET}`);

  const langfuseKeys = getLangfuseKeysFromDockerEnv();

  if (!langfuseKeys?.publicKey || !langfuseKeys?.secretKey) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Langfuse API keys not configured`);
    writeLine();
    writeLine(`  ${colors.dim}To enable telemetry:${RESET}`);
    writeLine(`  ${colors.dim}1. Open http://localhost:3100${RESET}`);
    writeLine(`  ${colors.dim}2. Create account and project${RESET}`);
    writeLine(`  ${colors.dim}3. Copy API keys to ${envPath}${RESET}`);
    writeLine(`  ${colors.dim}4. Run: squads stack init (again)${RESET}`);
  } else {
    writeLine(`  ${colors.green}${icons.success}${RESET} Langfuse keys configured`);
  }
  writeLine();

  // Step 6: Create ~/.squadsrc
  writeLine(`  ${bold}Step 6: CLI Configuration${RESET}`);

  const config: StackConfig = {
    ...DEFAULT_CONFIG,
    LANGFUSE_PUBLIC_KEY: langfuseKeys?.publicKey || '',
    LANGFUSE_SECRET_KEY: langfuseKeys?.secretKey || '',
  };

  saveStackConfig(config);
  writeLine(`  ${colors.green}${icons.success}${RESET} Config saved to ${colors.cyan}~/.squadsrc${RESET}`);
  writeLine();

  // Final summary
  writeLine(`  ${colors.green}${bold}Setup Complete!${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}To activate environment:${RESET}`);
  writeLine(`  ${colors.cyan}source ~/.squadsrc${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Add to ~/.zshrc for persistence:${RESET}`);
  writeLine(`  ${colors.cyan}[ -f ~/.squadsrc ] && source ~/.squadsrc${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Check status anytime:${RESET}`);
  writeLine(`  ${colors.cyan}squads stack health${RESET}`);
  writeLine();
}

/**
 * squads stack status - show connection health
 */
export async function stackStatusCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}stack status${RESET}`);
  writeLine();

  // Check Docker
  if (!isDockerRunning()) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Docker is not running`);
    writeLine();
    return;
  }

  // Container status
  const containers = [
    { name: 'squads-postgres', service: 'Database' },
    { name: 'squads-redis', service: 'Cache' },
    { name: 'squads-bridge', service: 'Bridge API' },
    { name: 'squads-langfuse', service: 'Langfuse' },
    { name: 'squads-otel-collector', service: 'Telemetry' },
  ];

  const w = { service: 12, container: 22, status: 12 };
  const tableWidth = w.service + w.container + w.status + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(
    `  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('SERVICE', w.service)}${RESET}${bold}${padEnd('CONTAINER', w.container)}${RESET}${bold}STATUS${RESET}      ${colors.purple}${box.vertical}${RESET}`
  );
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const { name, service } of containers) {
    const status = getContainerStatus(name);
    const statusIcon = status.running
      ? status.healthy
        ? `${colors.green}● healthy${RESET}`
        : `${colors.yellow}● starting${RESET}`
      : `${colors.red}○ stopped${RESET}`;

    writeLine(
      `  ${colors.purple}${box.vertical}${RESET} ${colors.cyan}${padEnd(service, w.service)}${RESET}${colors.dim}${padEnd(name, w.container)}${RESET}${statusIcon}  ${colors.purple}${box.vertical}${RESET}`
    );
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);

  // Config status
  writeLine();
  const config = loadStackConfig();
  if (config) {
    writeLine(`  ${colors.green}${icons.success}${RESET} Config loaded from ${colors.cyan}~/.squadsrc${RESET}`);

    // Check if env vars are set
    const envVars = ['SQUADS_DATABASE_URL', 'SQUADS_BRIDGE_URL', 'LANGFUSE_HOST'];
    const missing = envVars.filter((v) => !process.env[v]);

    if (missing.length > 0) {
      writeLine(`  ${colors.yellow}${icons.warning}${RESET} Env vars not in shell: ${colors.dim}${missing.join(', ')}${RESET}`);
      writeLine(`  ${colors.dim}Run: source ~/.squadsrc${RESET}`);
    } else {
      writeLine(`  ${colors.green}${icons.success}${RESET} All env vars loaded`);
    }
  } else {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} No config found`);
    writeLine(`  ${colors.dim}Run: squads stack init${RESET}`);
  }

  writeLine();
}

/**
 * squads stack env - print export commands
 */
export function stackEnvCommand(): void {
  const config = loadStackConfig();

  if (!config) {
    // Output defaults if no config
    console.log(`# Squads Local Stack - Default Config`);
    console.log(`# Run 'squads stack init' to auto-detect and save`);
    console.log();
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      console.log(`export ${key}="${value}"`);
    }
    return;
  }

  // Output saved config
  console.log(`# Squads Local Stack Config`);
  console.log(`# From: ~/.squadsrc`);
  console.log();
  for (const [key, value] of Object.entries(config)) {
    console.log(`export ${key}="${value}"`);
  }
}

/**
 * squads stack up - start docker compose
 */
export async function stackUpCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}stack up${RESET}`);
  writeLine();

  const composeDir = findDockerComposeDir();

  if (!composeDir) {
    writeLine(`  ${colors.red}${icons.error}${RESET} docker-compose.yml not found`);
    writeLine();
    writeLine(`  ${colors.dim}Expected locations:${RESET}`);
    writeLine(`  ${colors.dim}  ./docker/docker-compose.yml${RESET}`);
    writeLine(`  ${colors.dim}  ~/agents-squads/squads-cli/docker/docker-compose.yml${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Starting containers from ${colors.dim}${composeDir}${RESET}`);
  writeLine();

  try {
    const child = spawn('docker-compose', ['up', '-d'], {
      cwd: composeDir,
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker-compose exited with code ${code}`));
      });
      child.on('error', reject);
    });

    writeLine();
    writeLine(`  ${colors.green}${icons.success}${RESET} Stack started`);
    writeLine(`  ${colors.dim}Run: squads stack init${RESET} to configure CLI`);
    writeLine();
  } catch (error) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Failed to start stack`);
    writeLine(`  ${colors.dim}${error}${RESET}`);
    writeLine();
  }
}

/**
 * squads stack health - comprehensive health check with diagnostics
 */
export async function stackHealthCommand(verbose = false): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}stack health${RESET}`);
  writeLine();

  // Check Docker
  if (!isDockerRunning()) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Docker is not running`);
    writeLine();
    process.exitCode = 1;
    return;
  }

  // All containers including engram stack
  const containers = [
    { name: 'squads-postgres', service: 'postgres', healthUrl: '', critical: true },
    { name: 'squads-redis', service: 'redis', healthUrl: '', critical: true },
    { name: 'squads-neo4j', service: 'neo4j', healthUrl: 'http://localhost:7474', critical: false },
    { name: 'squads-bridge', service: 'bridge', healthUrl: 'http://localhost:8088/health', critical: true },
    { name: 'squads-otel-collector', service: 'otel', healthUrl: '', critical: false },
    { name: 'squads-langfuse', service: 'langfuse', healthUrl: 'http://localhost:3100/api/public/health', critical: false },
    { name: 'squads-mem0', service: 'mem0', healthUrl: 'http://localhost:8000/health', critical: false },
    { name: 'squads-engram-mcp', service: 'engram', healthUrl: 'http://localhost:8080/', critical: false },
  ];

  let hasFailures = false;
  const results: Array<{ name: string; service: string; ok: boolean; status: string; logs?: string }> = [];

  for (const container of containers) {
    const status = getContainerStatus(container.name);
    let ok = status.running && status.healthy;
    let statusText = '';

    if (!status.running) {
      statusText = 'stopped';
      ok = false;
    } else if (!status.healthy) {
      statusText = 'unhealthy';
      ok = false;
    } else if (container.healthUrl) {
      // Additional HTTP health check
      const httpOk = await checkService(container.healthUrl);
      if (!httpOk) {
        statusText = 'not responding';
        ok = false;
      } else {
        statusText = 'healthy';
      }
    } else {
      statusText = 'healthy';
    }

    // Get logs if unhealthy
    let logs: string | undefined;
    if (!ok && verbose) {
      try {
        logs = execSync(`docker logs ${container.name} --tail 10 2>&1`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        logs = '(no logs available)';
      }
    }

    if (!ok && container.critical) {
      hasFailures = true;
    }

    results.push({ name: container.name, service: container.service, ok, status: statusText, logs });
  }

  // Display results
  for (const r of results) {
    const icon = r.ok ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
    const statusColor = r.ok ? colors.green : colors.red;
    writeLine(`  ${icon} ${padEnd(r.service, 10)} ${statusColor}${r.status}${RESET}`);

    if (r.logs && !r.ok) {
      writeLine(`    ${colors.dim}${'-'.repeat(40)}${RESET}`);
      for (const line of r.logs.split('\n').slice(0, 5)) {
        writeLine(`    ${colors.dim}${line.substring(0, 70)}${RESET}`);
      }
    }
  }

  writeLine();

  // Summary
  const healthy = results.filter((r) => r.ok).length;
  const total = results.length;

  if (hasFailures) {
    writeLine(`  ${colors.red}${icons.error}${RESET} ${healthy}/${total} services healthy - critical failures`);
    writeLine(`  ${colors.dim}Run with -v for logs: squads stack health -v${RESET}`);
    process.exitCode = 1;
  } else if (healthy < total) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} ${healthy}/${total} services healthy - non-critical issues`);
  } else {
    writeLine(`  ${colors.green}${icons.success}${RESET} ${healthy}/${total} services healthy`);
  }

  writeLine();
}

/**
 * squads stack logs - show logs for a specific service
 */
export function stackLogsCommand(service: string, tail = 50): void {
  const containerMap: Record<string, string> = {
    postgres: 'squads-postgres',
    redis: 'squads-redis',
    neo4j: 'squads-neo4j',
    bridge: 'squads-bridge',
    otel: 'squads-otel-collector',
    langfuse: 'squads-langfuse',
    mem0: 'squads-mem0',
    engram: 'squads-engram-mcp',
  };

  const container = containerMap[service] || `squads-${service}`;

  try {
    execSync(`docker logs ${container} --tail ${tail}`, { stdio: 'inherit' });
  } catch {
    writeLine(`  ${colors.red}${icons.error}${RESET} Container ${container} not found`);
  }
}

/**
 * squads stack down - stop docker compose
 */
export async function stackDownCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}stack down${RESET}`);
  writeLine();

  const composeDir = findDockerComposeDir();

  if (!composeDir) {
    writeLine(`  ${colors.red}${icons.error}${RESET} docker-compose.yml not found`);
    writeLine();
    return;
  }

  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Stopping containers...`);
  writeLine();

  try {
    const child = spawn('docker-compose', ['down'], {
      cwd: composeDir,
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker-compose exited with code ${code}`));
      });
      child.on('error', reject);
    });

    writeLine();
    writeLine(`  ${colors.green}${icons.success}${RESET} Stack stopped`);
    writeLine();
  } catch (error) {
    writeLine(`  ${colors.red}${icons.error}${RESET} Failed to stop stack`);
    writeLine(`  ${colors.dim}${error}${RESET}`);
    writeLine();
  }
}
