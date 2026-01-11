/**
 * squads providers - Show available LLM CLI providers
 *
 * Lists all supported LLM CLIs and their availability status.
 * Provides install instructions for missing CLIs.
 *
 * @see specs/multi-llm.md
 */

import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { getAllCLIStatus, CLIStatus } from '../lib/llm-clis.js';
import { track, Events } from '../lib/telemetry.js';

export interface ProvidersOptions {
  json?: boolean;
}

/**
 * Show status of all LLM CLI providers
 */
export async function providersCommand(options: ProvidersOptions = {}): Promise<void> {
  const statuses = getAllCLIStatus();

  // Track telemetry
  await track(Events.CLI_PROVIDERS, {
    available: statuses.filter((s) => s.available).length,
    total: statuses.length,
  });

  // JSON output for programmatic use
  if (options.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  // Pretty output
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}providers${RESET}`);
  writeLine();

  // Header
  writeLine(`  ${colors.dim}Provider     CLI       Status${RESET}`);
  writeLine(`  ${colors.dim}${'─'.repeat(40)}${RESET}`);

  // Provider rows
  const ready: CLIStatus[] = [];
  const missing: CLIStatus[] = [];

  for (const status of statuses) {
    const statusText = status.available
      ? `${colors.green}${icons.success} ready${RESET}`
      : `${colors.red}${icons.error} not installed${RESET}`;

    // Pad columns for alignment
    const providerCol = status.displayName.padEnd(12);
    const commandCol = status.command.padEnd(9);

    writeLine(`  ${colors.cyan}${providerCol}${RESET} ${commandCol} ${statusText}`);

    if (status.available) {
      ready.push(status);
    } else {
      missing.push(status);
    }
  }

  writeLine();

  // Summary
  if (ready.length === statuses.length) {
    writeLine(`  ${colors.green}${icons.success}${RESET} All providers ready`);
  } else {
    writeLine(`  ${colors.dim}${ready.length}/${statuses.length} providers available${RESET}`);
  }

  // Install instructions for missing
  if (missing.length > 0) {
    writeLine();
    writeLine(`  ${colors.dim}Install missing:${RESET}`);

    for (const status of missing) {
      writeLine(`    ${colors.dim}$${RESET} ${status.install}`);
    }
  }

  writeLine();
}
