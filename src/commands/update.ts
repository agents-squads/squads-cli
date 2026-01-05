/**
 * squads update - Check and install updates
 */

import { createInterface } from 'readline';
import {
  refreshVersionCache,
  performUpdate,
} from '../lib/update.js';
import {
  colors,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface UpdateOptions {
  yes?: boolean;
  check?: boolean;
}

/**
 * Prompt user for yes/no confirmation
 */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${message} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}update${RESET}`);
  writeLine();

  // Check-only mode
  if (options.check) {
    writeLine(`  ${colors.dim}Checking for updates...${RESET}`);
    const info = refreshVersionCache();
    writeLine();

    if (info.updateAvailable) {
      writeLine(`  ${colors.cyan}⬆${RESET} Update available: ${colors.dim}${info.currentVersion}${RESET} → ${colors.green}${info.latestVersion}${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Run \`squads update\` to install${RESET}`);
    } else {
      writeLine(`  ${colors.green}${icons.success}${RESET} Already on latest version ${colors.cyan}${info.currentVersion}${RESET}`);
    }
    writeLine();
    return;
  }

  // Check for updates
  writeLine(`  ${colors.dim}Checking npm registry...${RESET}`);
  const info = refreshVersionCache();

  if (!info.updateAvailable) {
    writeLine();
    writeLine(`  ${colors.green}${icons.success}${RESET} Already on latest version ${colors.cyan}${info.currentVersion}${RESET}`);
    writeLine();
    return;
  }

  writeLine();
  writeLine(`  ${colors.cyan}⬆${RESET} Update available: ${colors.dim}${info.currentVersion}${RESET} → ${colors.green}${info.latestVersion}${RESET}`);
  writeLine();

  // Auto-confirm with --yes flag, otherwise prompt
  const shouldUpdate = options.yes || (await confirm('Update now?'));

  if (!shouldUpdate) {
    writeLine();
    writeLine(`  ${colors.dim}Update skipped${RESET}`);
    writeLine();
    return;
  }

  writeLine();
  writeLine(`  ${colors.dim}Installing update...${RESET}`);
  writeLine();

  const result = performUpdate();

  writeLine();
  if (result.success) {
    writeLine(`  ${colors.green}${icons.success}${RESET} Updated to ${colors.green}${info.latestVersion}${RESET}`);
    writeLine(`  ${colors.dim}Restart your terminal to use the new version${RESET}`);
  } else {
    writeLine(`  ${colors.red}${icons.error}${RESET} Update failed: ${result.error}`);
    writeLine(`  ${colors.dim}Try manually: npm update -g squads-cli${RESET}`);
    process.exitCode = 1;
  }
  writeLine();
}
