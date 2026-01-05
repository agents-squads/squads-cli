// squads-cli library exports
export { version } from './version.js';

// Types
export interface Agent {
  name: string;
  model: string;
  tools: string[];
  trigger: 'manual' | 'scheduled' | 'event';
}

export interface Squad {
  name: string;
  agents: Agent[];
  mission?: string;
}

// Note: Programmatic API (loadSquad, runAgent) not yet implemented.
// Use the CLI for squad execution: `squads run <squad>`
// See: https://github.com/agents-squads/squads-cli for documentation.
