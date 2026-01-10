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

// Context Condenser - for programmatic API usage
export {
  ContextCondenser,
  createCondenser,
  CondenserConfig,
  CondenserResult,
  CondenserMessage,
  TokenTracker,
  CompressionLevel,
  ThresholdConfig,
  estimateTokens,
  estimateMessageTokens,
  createTracker,
  updateTracker,
  getCompressionLevel,
  formatTrackerStatus,
  FileDeduplicator,
  TokenPruner,
  ConversationSummarizer,
} from './lib/condenser/index.js';

// Note: Programmatic API (loadSquad, runAgent) not yet implemented.
// Use the CLI for squad execution: `squads run <squad>`
// See: https://github.com/agents-squads/squads-cli for documentation.
