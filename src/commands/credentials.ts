/**
 * squads credentials — manage per-squad GCP service accounts and credentials.
 *
 * Creates, rotates, lists, and revokes service accounts so agents
 * can access the APIs they need without founder intervention.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { findSquadsDir } from '../lib/squad-parser.js';
import { colors, bold, RESET, writeLine, icons } from '../lib/terminal.js';
import { homedir } from 'os';

// ── Permission mapping per squad ────────────────────────────────────────
// Each squad gets ONLY the GCP roles it needs. Principle of least privilege.

interface SquadPermissions {
  roles: string[];
  apis: string[];       // APIs to enable on the project
  description: string;
}

const SQUAD_PERMISSIONS: Record<string, SquadPermissions> = {
  analytics: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com'],
    description: 'BQ telemetry read access',
  },
  data: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser', 'roles/cloudsql.client'],
    apis: ['bigquery.googleapis.com', 'sqladmin.googleapis.com'],
    description: 'BQ read + Cloud SQL client',
  },
  finance: {
    roles: ['roles/drive.file', 'roles/sheets.editor'],
    apis: ['sheets.googleapis.com', 'drive.googleapis.com'],
    description: 'Google Sheets + Drive for financial models',
  },
  marketing: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com', 'searchconsole.googleapis.com'],
    description: 'BQ read + Search Console',
  },
  engineering: {
    roles: ['roles/cloudsql.admin', 'roles/run.developer', 'roles/secretmanager.secretAccessor'],
    apis: ['sqladmin.googleapis.com', 'run.googleapis.com', 'secretmanager.googleapis.com'],
    description: 'Cloud SQL admin + Cloud Run deploy + secrets',
  },
  customer: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com'],
    description: 'BQ telemetry for user analysis',
  },
  intelligence: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com'],
    description: 'BQ read for intelligence queries',
  },
  product: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com'],
    description: 'BQ telemetry for product analytics',
  },
  growth: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser'],
    apis: ['bigquery.googleapis.com'],
    description: 'BQ telemetry for growth metrics',
  },
  operations: {
    roles: ['roles/bigquery.dataViewer', 'roles/bigquery.jobUser', 'roles/monitoring.viewer'],
    apis: ['bigquery.googleapis.com', 'monitoring.googleapis.com'],
    description: 'BQ read + monitoring for ops health',
  },
};

const SECRETS_DIR = join(homedir(), '.squads', 'secrets');
const SA_SUFFIX = '-agent';

function getProject(): string {
  try {
    return execSync('gcloud config get-value project 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No GCP project configured. Run: gcloud config set project <project-id>');
  }
}

function saEmail(squad: string, project: string): string {
  return `${squad}${SA_SUFFIX}@${project}.iam.gserviceaccount.com`;
}

function keyPath(squad: string): string {
  return join(SECRETS_DIR, `${squad}-sa-key.json`);
}

function ensureSecretsDir(): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true });
  }
}

function gcloudExec(cmd: string, silent = false): string {
  try {
    const result = execSync(cmd, { encoding: 'utf-8', stdio: silent ? 'pipe' : ['pipe', 'inherit', 'inherit'] });
    return (result || '').trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Reauthentication')) {
      throw new Error('gcloud auth expired. Run: gcloud auth login');
    }
    throw e;
  }
}

// ── Commands ────────────────────────────────────────────────────────────

async function createCredential(squad: string, opts: { force?: boolean }): Promise<void> {
  const project = getProject();
  const email = saEmail(squad, project);
  const key = keyPath(squad);
  const perms = SQUAD_PERMISSIONS[squad];

  if (!perms) {
    writeLine(`  ${icons.error} ${colors.red}No permission mapping for squad "${squad}"${RESET}`);
    writeLine(`  ${colors.dim}Known squads: ${Object.keys(SQUAD_PERMISSIONS).join(', ')}${RESET}`);
    return;
  }

  if (existsSync(key) && !opts.force) {
    writeLine(`  ${icons.warning} ${colors.yellow}Credential already exists: ${key}${RESET}`);
    writeLine(`  ${colors.dim}Use --force to recreate${RESET}`);
    return;
  }

  ensureSecretsDir();

  writeLine(`  ${bold}Creating service account for ${squad}${RESET}`);
  writeLine(`  ${colors.dim}${perms.description}${RESET}`);
  writeLine();

  // 1. Enable required APIs
  for (const api of perms.apis) {
    writeLine(`  ${colors.dim}Enabling ${api}...${RESET}`);
    try {
      gcloudExec(`gcloud services enable ${api} --project ${project} 2>/dev/null`, true);
    } catch { /* already enabled or no permission — continue */ }
  }

  // 2. Create service account (or skip if exists)
  try {
    gcloudExec(`gcloud iam service-accounts describe ${email} --project ${project} 2>/dev/null`, true);
    writeLine(`  ${colors.dim}Service account exists: ${email}${RESET}`);
  } catch {
    writeLine(`  Creating ${email}...`);
    gcloudExec(`gcloud iam service-accounts create ${squad}${SA_SUFFIX} --display-name "Squads ${squad} agent" --project ${project}`);
  }

  // 3. Grant IAM roles
  for (const role of perms.roles) {
    writeLine(`  ${colors.dim}Granting ${role}...${RESET}`);
    try {
      gcloudExec(
        `gcloud projects add-iam-policy-binding ${project} --member="serviceAccount:${email}" --role="${role}" --condition=None --quiet 2>/dev/null`,
        true,
      );
    } catch { /* role may already be bound */ }
  }

  // 4. Create and download key
  if (existsSync(key) && opts.force) {
    unlinkSync(key);
  }
  writeLine(`  ${colors.dim}Creating key...${RESET}`);
  gcloudExec(`gcloud iam service-accounts keys create ${key} --iam-account=${email} --project ${project}`);

  writeLine();
  writeLine(`  ${icons.success} ${colors.green}${squad}${RESET} credential ready`);
  writeLine(`  ${colors.dim}Key: ${key}${RESET}`);
  writeLine(`  ${colors.dim}Roles: ${perms.roles.join(', ')}${RESET}`);
  writeLine();
}

async function rotateCredential(squad: string): Promise<void> {
  const project = getProject();
  const email = saEmail(squad, project);
  const key = keyPath(squad);

  if (!existsSync(key)) {
    writeLine(`  ${icons.error} ${colors.red}No credential found for ${squad}. Run: squads credentials create ${squad}${RESET}`);
    return;
  }

  // Read old key to get key ID for deletion
  const oldKeyData = JSON.parse(readFileSync(key, 'utf-8'));
  const oldKeyId = oldKeyData.private_key_id;

  writeLine(`  ${bold}Rotating ${squad} credential${RESET}`);

  // Create new key first
  const tmpKey = key + '.new';
  gcloudExec(`gcloud iam service-accounts keys create ${tmpKey} --iam-account=${email} --project ${project}`);

  // Replace old key file
  unlinkSync(key);
  const { renameSync } = await import('fs');
  renameSync(tmpKey, key);

  // Delete old key from GCP
  if (oldKeyId) {
    try {
      gcloudExec(
        `gcloud iam service-accounts keys delete ${oldKeyId} --iam-account=${email} --project ${project} --quiet`,
        true,
      );
    } catch { /* old key may already be expired */ }
  }

  writeLine(`  ${icons.success} ${colors.green}${squad}${RESET} credential rotated`);
  writeLine(`  ${colors.dim}New key: ${key}${RESET}`);
  writeLine();
}

async function listCredentials(): Promise<void> {
  ensureSecretsDir();
  const squadsDir = findSquadsDir();
  const allSquads = Object.keys(SQUAD_PERMISSIONS).sort();

  writeLine();
  writeLine(`  ${bold}Squad Credentials${RESET}`);
  writeLine();
  writeLine(`  ${'Squad'.padEnd(16)} ${'Status'.padEnd(10)} ${'Roles'.padEnd(40)} Key`);
  writeLine(`  ${'-'.repeat(90)}`);

  for (const squad of allSquads) {
    const key = keyPath(squad);
    const perms = SQUAD_PERMISSIONS[squad];
    const hasKey = existsSync(key);
    const status = hasKey ? `${colors.green}active${RESET}` : `${colors.dim}none${RESET}  `;
    const roles = perms.roles.map(r => r.split('/')[1]).join(', ');

    writeLine(`  ${squad.padEnd(16)} ${status} ${colors.dim}${roles.slice(0, 38).padEnd(40)}${RESET} ${hasKey ? '~/.squads/secrets/' + basename(key) : ''}`);
  }

  // Show squads without permission mapping
  if (squadsDir) {
    const dirs = readdirSync(squadsDir).filter(d =>
      existsSync(join(squadsDir, d, 'SQUAD.md')) && !SQUAD_PERMISSIONS[d]
    );
    if (dirs.length > 0) {
      writeLine();
      writeLine(`  ${colors.dim}Squads without permission mapping: ${dirs.join(', ')}${RESET}`);
      writeLine(`  ${colors.dim}Add to SQUAD_PERMISSIONS in credentials.ts if they need GCP access.${RESET}`);
    }
  }

  writeLine();
}

async function revokeCredential(squad: string): Promise<void> {
  const project = getProject();
  const email = saEmail(squad, project);
  const key = keyPath(squad);

  writeLine(`  ${bold}Revoking ${squad} credential${RESET}`);

  // Delete local key
  if (existsSync(key)) {
    unlinkSync(key);
    writeLine(`  ${colors.dim}Deleted local key${RESET}`);
  }

  // Delete all keys from GCP
  try {
    const keysJson = gcloudExec(
      `gcloud iam service-accounts keys list --iam-account=${email} --project ${project} --format=json 2>/dev/null`,
      true,
    );
    const keys = JSON.parse(keysJson);
    for (const k of keys) {
      if (k.keyType === 'USER_MANAGED') {
        gcloudExec(
          `gcloud iam service-accounts keys delete ${k.name.split('/').pop()} --iam-account=${email} --project ${project} --quiet`,
          true,
        );
      }
    }
    writeLine(`  ${colors.dim}Deleted remote keys${RESET}`);
  } catch { /* SA may not exist */ }

  // Delete service account
  try {
    gcloudExec(`gcloud iam service-accounts delete ${email} --project ${project} --quiet`);
    writeLine(`  ${colors.dim}Deleted service account${RESET}`);
  } catch { /* already deleted */ }

  writeLine(`  ${icons.success} ${colors.green}${squad}${RESET} credential revoked`);
  writeLine();
}

async function createAll(opts: { force?: boolean }): Promise<void> {
  const squads = Object.keys(SQUAD_PERMISSIONS).sort();
  writeLine(`  ${bold}Creating credentials for ${squads.length} squads${RESET}`);
  writeLine();

  for (const squad of squads) {
    await createCredential(squad, opts);
  }

  writeLine(`  ${bold}Done.${RESET} Run ${colors.cyan}squads credentials list${RESET} to verify.`);
  writeLine();
}

// ── Register ────────────────────────────────────────────────────────────

export function registerCredentialsCommand(program: Command): void {
  const creds = program
    .command('credentials')
    .description('Manage per-squad GCP service accounts and credentials');

  creds
    .command('create <squad>')
    .description('Create a service account and key for a squad')
    .option('--force', 'Recreate even if credential exists')
    .action(async (squad: string, opts) => {
      if (squad === '--all') {
        await createAll(opts);
      } else {
        await createCredential(squad, opts);
      }
    });

  creds
    .command('create-all')
    .description('Create credentials for all squads with permission mappings')
    .option('--force', 'Recreate even if credentials exist')
    .action(async (opts) => {
      await createAll(opts);
    });

  creds
    .command('rotate <squad>')
    .description('Rotate a squad credential (create new key, delete old)')
    .action(async (squad: string) => {
      await rotateCredential(squad);
    });

  creds
    .command('list')
    .description('List all squad credentials and their status')
    .action(async () => {
      await listCredentials();
    });

  creds
    .command('revoke <squad>')
    .description('Delete a squad service account and all keys')
    .action(async (squad: string) => {
      await revokeCredential(squad);
    });
}

// ── Helper for execution engine ─────────────────────────────────────────

/**
 * Resolve the credential path for a squad. Returns the path to the
 * service account key file if it exists, or undefined.
 * Used by the execution engine to inject GOOGLE_APPLICATION_CREDENTIALS.
 */
export function resolveSquadCredential(squad: string): string | undefined {
  const key = keyPath(squad);
  return existsSync(key) ? key : undefined;
}
