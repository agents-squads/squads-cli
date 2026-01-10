// squads-cli library exports
export { version } from './version.js';

// SQUAD.md Parser - parse and work with SQUAD.md files programmatically
// See: https://github.com/agents-squads/agents-squads/blob/main/SQUAD.md
export {
  // Core functions
  parseSquadFile,
  loadSquad,
  loadAgentDefinition,
  listSquads,
  listAgents,
  findSquadsDir,
  findProjectRoot,
  // Goal management
  addGoalToSquad,
  updateGoalInSquad,
  // Types
  type Squad,
  type Agent,
  type Goal,
  type Pipeline,
  type SquadContext,
  type SquadFrontmatter,
  type EffortLevel,
} from './lib/squad-parser.js';

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

// Usage:
//   import { loadSquad, parseSquadFile } from 'squads-cli';
//   const squad = loadSquad('engineering');
//   console.log(squad.agents);
//
// CLI: `squads run <squad>` for execution
// Docs: https://github.com/agents-squads/squads-cli
