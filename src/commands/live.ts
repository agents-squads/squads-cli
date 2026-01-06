import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { execSync } from 'child_process';

interface LiveOptions {
  minimal?: boolean;
  focus?: string;
}

interface AgentStatus {
  name: string;
  squad: string;
  status: 'active' | 'idle' | 'done';
  duration: string;
  cpu: string;
  mem: string;
}

interface CostData {
  today: number;
  week: number;
  budget: number;
}

/**
 * Live TUI Dashboard - Real-time squad monitoring
 * Uses blessed-contrib for terminal UI
 */
export async function liveCommand(_options: LiveOptions): Promise<void> {
  // Create blessed screen
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Squads Live Dashboard',
    fullUnicode: true,
  });

  // Create grid layout
  const grid = new contrib.grid({
    rows: 12,
    cols: 12,
    screen: screen,
  });

  // === TOP ROW: Agents + Cost ===

  // Agents table (left)
  const agentsTable = grid.set(0, 0, 6, 8, contrib.table, {
    keys: true,
    fg: 'white',
    label: ' Running Agents ',
    columnSpacing: 2,
    columnWidth: [20, 12, 10, 8, 8],
    border: { type: 'line', fg: 'cyan' },
  });

  // Cost gauge (right)
  const costGauge = grid.set(0, 8, 3, 4, contrib.gauge, {
    label: ' Budget Used ',
    stroke: 'green',
    fill: 'white',
    border: { type: 'line', fg: 'cyan' },
  });

  // Cost details (right below gauge)
  const costLog = grid.set(3, 8, 3, 4, contrib.log, {
    fg: 'green',
    label: ' Cost Tracker ',
    border: { type: 'line', fg: 'cyan' },
  });

  // === BOTTOM ROW: Activity + Memory ===

  // Activity log (left)
  const activityLog = grid.set(6, 0, 6, 6, contrib.log, {
    fg: 'cyan',
    label: ' Recent Activity ',
    border: { type: 'line', fg: 'magenta' },
  });

  // Memory updates (right)
  const memoryLog = grid.set(6, 6, 6, 6, contrib.log, {
    fg: 'yellow',
    label: ' Memory Updates ',
    border: { type: 'line', fg: 'magenta' },
  });

  // === Data fetching functions ===

  function getAgents(): AgentStatus[] {
    try {
      const output = execSync('ps aux | grep -E "claude|node.*squads" | grep -v grep', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const agents: AgentStatus[] = [];
      const lines = output.trim().split('\n').slice(0, 10);

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10) {
          const cpu = parts[2];
          const mem = parts[3];
          const time = parts[9];
          const cmd = parts.slice(10).join(' ');

          // Parse agent name from command
          let name = 'claude';
          let squad = 'unknown';

          if (cmd.includes('squads-')) {
            const match = cmd.match(/squads-(\w+)-(\w+)/);
            if (match) {
              squad = match[1];
              name = match[2];
            }
          }

          agents.push({
            name: name.substring(0, 18),
            squad: squad.substring(0, 10),
            status: parseFloat(cpu) > 5 ? 'active' : 'idle',
            duration: time,
            cpu: cpu + '%',
            mem: mem + '%',
          });
        }
      }

      return agents.slice(0, 8);
    } catch {
      return [];
    }
  }

  function getCosts(): CostData {
    // In a real implementation, this would fetch from Langfuse
    // For now, return mock data that updates
    const baseToday = 12.50;
    const baseWeek = 89.20;
    const variance = Math.random() * 0.5;

    return {
      today: baseToday + variance,
      week: baseWeek + variance * 10,
      budget: 200,
    };
  }

  function getRecentActivity(): string[] {
    try {
      const output = execSync(
        'gh issue list --repo agents-squads/squads-cli --state open --limit 5 --json number,title,createdAt 2>/dev/null',
        { encoding: 'utf-8', timeout: 10000 }
      );

      const issues = JSON.parse(output);
      return issues.map((i: { number: number; title: string }) =>
        `#${i.number} ${i.title.substring(0, 40)}`
      );
    } catch {
      return ['(loading...)'];
    }
  }

  function getMemoryUpdates(): string[] {
    try {
      const output = execSync(
        'find .agents/memory -name "state.md" -mmin -60 2>/dev/null | head -5',
        { encoding: 'utf-8', timeout: 5000 }
      );

      return output.trim().split('\n')
        .filter(Boolean)
        .map(path => {
          const parts = path.split('/');
          const squad = parts[2] || '';
          const agent = parts[3] || '';
          return `${squad}/${agent}`;
        });
    } catch {
      return ['(no recent updates)'];
    }
  }

  // === Update functions ===

  function updateAgents() {
    const agents = getAgents();
    const data = agents.length > 0
      ? agents.map(a => [a.name, a.squad, a.status === 'active' ? '● active' : '○ idle', a.cpu, a.mem])
      : [['(no agents running)', '', '', '', '']];

    agentsTable.setData({
      headers: ['Agent', 'Squad', 'Status', 'CPU', 'MEM'],
      data: data,
    });
  }

  function updateCosts() {
    const costs = getCosts();
    const percent = Math.round((costs.week / costs.budget) * 100);

    costGauge.setPercent(percent);
    costLog.log(`Today:  $${costs.today.toFixed(2)}`);
    costLog.log(`Week:   $${costs.week.toFixed(2)} / $${costs.budget}`);
  }

  function updateActivity() {
    const activities = getRecentActivity();
    activities.forEach(a => activityLog.log(a));
  }

  function updateMemory() {
    const updates = getMemoryUpdates();
    updates.forEach(u => memoryLog.log(u));
  }

  // === Initial render ===
  updateAgents();
  updateCosts();
  updateActivity();
  updateMemory();
  screen.render();

  // === Set up refresh intervals ===
  const agentInterval = setInterval(() => {
    updateAgents();
    screen.render();
  }, 2000);

  const costInterval = setInterval(() => {
    updateCosts();
    screen.render();
  }, 5000);

  const activityInterval = setInterval(() => {
    updateActivity();
    screen.render();
  }, 10000);

  const memoryInterval = setInterval(() => {
    updateMemory();
    screen.render();
  }, 15000);

  // === Key bindings ===
  screen.key(['escape', 'q', 'C-c'], () => {
    clearInterval(agentInterval);
    clearInterval(costInterval);
    clearInterval(activityInterval);
    clearInterval(memoryInterval);
    return process.exit(0);
  });

  screen.key(['r'], () => {
    updateAgents();
    updateCosts();
    updateActivity();
    updateMemory();
    screen.render();
  });

  // Focus on agents table
  agentsTable.focus();
}
