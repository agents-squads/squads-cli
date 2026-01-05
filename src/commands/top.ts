import { execSync } from 'child_process';

interface ProcessInfo {
  pid: string;
  cpu: string;
  mem: string;
  time: string;
  status: 'active' | 'idle';
  cmd: string;
}

// ANSI escape codes
const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J`;
const CURSOR_HOME = `${ESC}[H`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const MAGENTA = `${ESC}[35m`;

/**
 * Top command - live updating process table like Unix top
 * Single table, numbers update in place
 */
export async function topCommand(): Promise<void> {
  // Hide cursor and clear screen once
  process.stdout.write(CURSOR_HIDE + CLEAR_SCREEN + CURSOR_HOME);

  let running = true;

  // Handle exit
  const cleanup = () => {
    running = false;
    process.stdout.write(CURSOR_SHOW + '\n');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Main loop
  while (running) {
    const data = getProcessData();
    render(data);
    await sleep(1000); // Update every 1 second like top
  }
}

function getProcessData(): { processes: ProcessInfo[]; summary: { claude: number; tasks: number; agents: number } } {
  const processes: ProcessInfo[] = [];
  let claudeCount = 0;
  let agentCount = 0;

  try {
    // Get Claude processes
    const psOutput = execSync(
      'ps aux | grep -E "[c]laude" | head -15',
      { encoding: 'utf-8', timeout: 5000 }
    );

    const lines = psOutput.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        const pid = parts[1];
        const cpu = parts[2];
        const mem = parts[3];
        const time = parts[9];
        const cmd = parts.slice(10).join(' ').substring(0, 30);

        const cpuNum = parseFloat(cpu);
        const status = cpuNum > 5 ? 'active' : 'idle';

        if (cmd.includes('squads-')) {
          agentCount++;
        }
        claudeCount++;

        processes.push({ pid, cpu, mem, time, status, cmd });
      }
    }
  } catch {
    // No processes found
  }

  // Get tmux agent sessions
  try {
    const tmuxOutput = execSync('tmux ls 2>/dev/null | grep squads- | wc -l', { encoding: 'utf-8' });
    agentCount = parseInt(tmuxOutput.trim()) || 0;
  } catch {
    // tmux not available or no sessions
  }

  return {
    processes: processes.slice(0, 12),
    summary: { claude: claudeCount, tasks: 0, agents: agentCount }
  };
}

function render(data: { processes: ProcessInfo[]; summary: { claude: number; tasks: number; agents: number } }): void {
  const now = new Date().toLocaleTimeString();
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(`  ${MAGENTA}squads${RESET} ${DIM}top${RESET}  ${DIM}${now}${RESET}  ${DIM}(q to quit)${RESET}`);
  lines.push('');

  // Summary line
  const activeCount = data.processes.filter(p => p.status === 'active').length;
  lines.push(`  ${CYAN}${data.summary.claude}${RESET} claude  ${DIM}│${RESET}  ${GREEN}${activeCount}${RESET} active  ${DIM}│${RESET}  ${YELLOW}${data.summary.agents}${RESET} agents`);
  lines.push('');

  // Table header
  lines.push(`  ${BOLD}PID      CPU%    MEM%    TIME      STATUS${RESET}`);
  lines.push(`  ${DIM}${'─'.repeat(50)}${RESET}`);

  // Process rows
  if (data.processes.length === 0) {
    lines.push(`  ${DIM}(no claude processes)${RESET}`);
  } else {
    for (const p of data.processes) {
      const statusIcon = p.status === 'active' ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
      const statusText = p.status === 'active' ? `${GREEN}active${RESET}` : `${DIM}idle${RESET}`;
      const cpuColor = parseFloat(p.cpu) > 10 ? YELLOW : '';

      lines.push(
        `  ${CYAN}${p.pid.padEnd(8)}${RESET}` +
        `${cpuColor}${p.cpu.padStart(5)}${RESET}   ` +
        `${p.mem.padStart(5)}   ` +
        `${p.time.padEnd(10)}` +
        `${statusIcon} ${statusText}`
      );
    }
  }

  // Footer
  lines.push('');
  lines.push(`  ${DIM}Press q to quit, r to refresh${RESET}`);
  lines.push('');

  // Move cursor home and render
  process.stdout.write(CURSOR_HOME);

  // Write each line, clearing to end of line
  for (const line of lines) {
    process.stdout.write(line + `${ESC}[K\n`);
  }

  // Clear remaining lines
  for (let i = 0; i < 5; i++) {
    process.stdout.write(`${ESC}[K\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle keypress for quit
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    // q or Ctrl+C
    if (key.toString() === 'q' || key[0] === 3) {
      process.stdout.write(CURSOR_SHOW + '\n');
      process.exit(0);
    }
    // r for refresh (handled by main loop anyway)
  });
}
