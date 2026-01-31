/**
 * Config command - manage CLI configuration
 *
 * Handles ~/.squads/config.json for user settings.
 */

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  get,
  set,
  unset,
  parseValue,
  createDefaultConfig,
  type SquadsConfig,
} from '../lib/config.js';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';

/**
 * Show all config (default action)
 */
export async function configCommand(): Promise<void> {
  const config = loadConfig();
  const configPath = getConfigPath();

  if (Object.keys(config).length === 0) {
    writeLine();
    writeLine(`  ${colors.yellow}No configuration found${RESET}`);
    writeLine(`  ${colors.dim}Config file: ${configPath}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Create default config:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads config init`);
    writeLine();
    return;
  }

  writeLine();
  writeLine(`  ${bold}Configuration${RESET} ${colors.dim}(${configPath})${RESET}`);
  writeLine();

  const json = JSON.stringify(config, null, 2);
  const lines = json.trim().split('\n');

  for (const line of lines) {
    writeLine(`  ${colors.dim}${line}${RESET}`);
  }

  writeLine();
}

/**
 * Initialize config with defaults
 */
export async function configInitCommand(): Promise<void> {
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    writeLine();
    writeLine(`  ${colors.yellow}Config already exists${RESET}`);
    writeLine(`  ${colors.dim}${configPath}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}To reset, delete the file and run:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads config init`);
    writeLine();
    return;
  }

  const defaultConfig = createDefaultConfig();
  saveConfig(defaultConfig);

  writeLine();
  writeLine(`  ${colors.green}✓${RESET} Created default configuration`);
  writeLine(`  ${colors.dim}${configPath}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Edit with:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads config edit`);
  writeLine();
}

/**
 * Get a config value
 */
export async function configGetCommand(key: string): Promise<void> {
  const config = loadConfig();
  const value = get(config, key);

  if (value === undefined) {
    writeLine();
    writeLine(`  ${colors.red}Key not found:${RESET} ${key}`);
    writeLine();
    process.exit(1);
  }

  // Output value directly (for scripting)
  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

/**
 * Set a config value
 */
export async function configSetCommand(key: string, value: string): Promise<void> {
  const config = loadConfig();
  const parsedValue = parseValue(value);

  set(config, key, parsedValue);
  saveConfig(config);

  writeLine();
  writeLine(`  ${colors.green}✓${RESET} Updated ${colors.cyan}${key}${RESET}`);
  writeLine(`  ${colors.dim}${JSON.stringify(parsedValue)}${RESET}`);
  writeLine();
}

/**
 * Unset a config value
 */
export async function configUnsetCommand(key: string): Promise<void> {
  const config = loadConfig();

  // Check if key exists
  if (get(config, key) === undefined) {
    writeLine();
    writeLine(`  ${colors.yellow}Key not found:${RESET} ${key}`);
    writeLine();
    return;
  }

  unset(config, key);
  saveConfig(config);

  writeLine();
  writeLine(`  ${colors.green}✓${RESET} Removed ${colors.cyan}${key}${RESET}`);
  writeLine();
}

/**
 * Edit config in $EDITOR
 */
export async function configEditCommand(): Promise<void> {
  const configPath = getConfigPath();

  // Create default config if it doesn't exist
  if (!existsSync(configPath)) {
    const defaultConfig = createDefaultConfig();
    saveConfig(defaultConfig);
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';

  writeLine();
  writeLine(`  ${colors.dim}Opening ${configPath} in ${editor}...${RESET}`);
  writeLine();

  const child = spawn(editor, [configPath], {
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code === 0) {
      writeLine();
      writeLine(`  ${colors.green}✓${RESET} Config updated`);
      writeLine();
    } else {
      writeLine();
      writeLine(`  ${colors.red}✗${RESET} Editor exited with code ${code}`);
      writeLine();
      process.exit(code || 1);
    }
  });

  child.on('error', (err) => {
    writeLine();
    writeLine(`  ${colors.red}✗${RESET} Failed to open editor: ${err.message}`);
    writeLine();
    process.exit(1);
  });
}

/**
 * Show config file path
 */
export async function configPathCommand(): Promise<void> {
  const configPath = getConfigPath();
  console.log(configPath);
}
