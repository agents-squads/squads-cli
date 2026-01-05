import { spawn } from 'child_process';
import { colors, RESET, gradient, writeLine } from '../lib/terminal.js';

interface WatchOptions {
  interval?: number;
  clear?: boolean;
}

/**
 * Watch command - live refresh any squads command
 * Similar to Unix `watch` but integrated with squads CLI
 */
export async function watchCommand(
  command: string,
  args: string[],
  options: WatchOptions
): Promise<void> {
  const interval = (options.interval || 2) * 1000; // Default 2 seconds
  const shouldClear = options.clear !== false; // Default true

  // Validate command is a known squads command
  const validCommands = [
    'status', 'workers', 'dash', 'dashboard', 'sessions',
    'memory', 'history', 'results', 'progress', 'goal'
  ];

  if (!validCommands.includes(command)) {
    writeLine(`  ${colors.red}Unknown command: ${command}${RESET}`);
    writeLine(`  ${colors.dim}Valid commands: ${validCommands.join(', ')}${RESET}`);
    process.exit(1);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}watch${RESET} ${colors.cyan}${command}${RESET}`);
  writeLine(`  ${colors.dim}Refreshing every ${options.interval || 2}s (Ctrl+C to stop)${RESET}`);
  writeLine();

  // Initial run
  await runCommand(command, args, shouldClear);

  // Set up interval
  const timer = setInterval(async () => {
    await runCommand(command, args, shouldClear);
  }, interval);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    clearInterval(timer);
    writeLine();
    writeLine(`  ${colors.dim}Watch stopped${RESET}`);
    writeLine();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {}); // Never resolves, keeps running
}

async function runCommand(command: string, args: string[], clear: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (clear) {
      // Clear screen and move cursor to top
      process.stdout.write('\x1b[2J\x1b[H');
    }

    // Show timestamp
    const now = new Date().toLocaleTimeString();
    process.stdout.write(`\x1b[90m${now}\x1b[0m\n\n`);

    // Run the squads command
    const child = spawn('squads', [command, ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', () => {
      resolve();
    });

    child.on('error', (err) => {
      writeLine(`  ${colors.red}Error: ${err.message}${RESET}`);
      resolve();
    });
  });
}
