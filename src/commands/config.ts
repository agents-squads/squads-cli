/**
 * squads config — Switch and inspect environment configuration
 *
 * Subcommands:
 *   squads config use <env>    Switch to a named environment
 *   squads config show         Show current config and resolved URLs
 *
 * @see src/lib/env-config.ts for the config storage layer
 */

import { colors, RESET, writeLine } from '../lib/terminal.js';
import {
  getEnvName,
  getEnv,
  loadConfig,
  switchEnv,
} from '../lib/env-config.js';

export interface ConfigShowOptions {
  json?: boolean;
}

export interface ConfigUseOptions {
  json?: boolean;
}

/**
 * squads config show — Print the current environment config.
 *
 * Shows the active env name (noting SQUADS_ENV override if present) and the
 * resolved getEnv() values. Never prints secrets (none exist in the config
 * schema today).
 */
export async function configShowCommand(
  options: ConfigShowOptions = {},
): Promise<void> {
  const envName = getEnvName();
  const rawConfig = loadConfig();

  // Detect override
  const isOverridden = !!process.env.SQUADS_ENV;
  const effectiveName = isOverridden
    ? `${envName} (SQUADS_ENV override)`
    : envName;

  const env = getEnv();

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          current: envName,
          overridden: isOverridden,
          resolved: env,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeLine();
  writeLine(`  Config: ${colors.cyan}${effectiveName}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Environment URLs${RESET}`);
  writeLine(`  ${colors.dim}${'─'.repeat(40)}${RESET}`);
  writeLine(`  API:         ${env.api_url || colors.dim + '(none)' + RESET}`);
  writeLine(
    `  Admin API:   ${env.admin_api_url || colors.dim + '(none)' + RESET}`,
  );
  writeLine(
    `  Console:     ${env.console_url || colors.dim + '(none)' + RESET}`,
  );
  writeLine(
    `  Bridge:      ${env.bridge_url || colors.dim + '(none)' + RESET}`,
  );
  writeLine(
    `  Database:    ${env.database_url || colors.dim + '(none)' + RESET}`,
  );
  writeLine(
    `  Redis:       ${env.redis_url || colors.dim + '(none)' + RESET}`,
  );
  writeLine(
    `  Execution:   ${env.execution || colors.dim + '(none)' + RESET}`,
  );

  if (rawConfig.email) {
    writeLine();
    writeLine(`  ${colors.dim}Email: ${rawConfig.email}${RESET}`);
  }
  writeLine();
}

/**
 * squads config use <env> — Switch to a named environment.
 *
 * Validates the env name against the known environments map, persists the
 * change, and prints the result.
 */
export async function configUseCommand(
  name: string,
  options: ConfigUseOptions = {},
): Promise<void> {
  const config = switchEnv(name);
  const env = config.environments[name];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          current: name,
          api_url: env.api_url,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeLine();
  writeLine(
    `  Switched to ${colors.green}${name}${RESET} — ${colors.dim}${env.api_url || '(no API URL)'}${RESET}`,
  );
  writeLine();
}
