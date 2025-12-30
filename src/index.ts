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

// Core functions (to be implemented)
export async function loadSquad(path: string): Promise<Squad | null> {
  // TODO: Load squad from markdown file
  return null;
}

export async function runAgent(agent: Agent, prompt: string): Promise<string> {
  // TODO: Execute agent
  return '';
}
