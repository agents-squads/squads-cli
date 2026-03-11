/**
 * Lead Orchestrator - Persistent squad lead that coordinates workers
 *
 * Pattern:
 * 1. Lead agent runs as persistent session
 * 2. Lead spawns worker agents for specific tasks
 * 3. Workers complete and signal via events
 * 4. Lead reviews outputs and decides next steps
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, watch } from 'fs';
import { join } from 'path';

export interface WorkerEvent {
  type: 'started' | 'completed' | 'failed' | 'output';
  squad: string;
  agent: string;
  executionId: string;
  timestamp: string;
  exitCode?: number;
  outputPath?: string;
  summary?: string;
  error?: string;
}

export interface OrchestratorConfig {
  projectRoot: string;
  squad: string;
  lead: string;
  eventsDir: string;
  onWorkerComplete?: (event: WorkerEvent) => void;
}

/**
 * Events directory structure:
 * .agents/events/
 *   pending/     - New events waiting for lead to process
 *   processed/   - Events that lead has reviewed
 */
export function initEventsDir(projectRoot: string): string {
  const eventsDir = join(projectRoot, '.agents', 'events');
  const pendingDir = join(eventsDir, 'pending');
  const processedDir = join(eventsDir, 'processed');

  [eventsDir, pendingDir, processedDir].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });

  return eventsDir;
}

/**
 * Worker signals completion by writing event file
 */
export function signalWorkerComplete(config: {
  eventsDir: string;
  squad: string;
  agent: string;
  executionId: string;
  exitCode: number;
  outputPath?: string;
  summary?: string;
}): void {
  const event: WorkerEvent = {
    type: config.exitCode === 0 ? 'completed' : 'failed',
    squad: config.squad,
    agent: config.agent,
    executionId: config.executionId,
    timestamp: new Date().toISOString(),
    exitCode: config.exitCode,
    outputPath: config.outputPath,
    summary: config.summary,
  };

  const filename = `${config.executionId}-${config.agent}.json`;
  const filepath = join(config.eventsDir, 'pending', filename);
  writeFileSync(filepath, JSON.stringify(event, null, 2));
}

/**
 * Read pending events for lead to review
 */
export function getPendingEvents(eventsDir: string): WorkerEvent[] {
  const pendingDir = join(eventsDir, 'pending');
  if (!existsSync(pendingDir)) return [];

  const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const content = readFileSync(join(pendingDir, f), 'utf-8');
    return JSON.parse(content) as WorkerEvent;
  });
}

/**
 * Mark event as processed (move to processed dir)
 */
export function markEventProcessed(eventsDir: string, event: WorkerEvent): void {
  const filename = `${event.executionId}-${event.agent}.json`;
  const pendingPath = join(eventsDir, 'pending', filename);
  const processedPath = join(eventsDir, 'processed', filename);

  if (existsSync(pendingPath)) {
    const content = readFileSync(pendingPath, 'utf-8');
    writeFileSync(processedPath, content);
    unlinkSync(pendingPath);
  }
}

/**
 * Generate shell command for worker that signals completion
 */
export function buildWorkerCommand(config: {
  projectRoot: string;
  squad: string;
  agent: string;
  executionId: string;
  prompt: string;
  mcpConfigPath: string;
  sessionName: string;
}): string {
  const eventsDir = join(config.projectRoot, '.agents', 'events');
  const escapedPrompt = config.prompt.replace(/'/g, "'\\''");

  // Worker command that:
  // 1. Runs claude with acceptEdits (pre-configured permissions)
  // 2. Captures exit code
  // 3. Signals completion via event file
  // 4. Kills tmux session
  return `
cd '${config.projectRoot}' && \\
unset CLAUDECODE && claude --print --permission-mode acceptEdits --mcp-config '${config.mcpConfigPath}' -- '${escapedPrompt}'; \\
EXIT_CODE=$?; \\
echo '{"type":"'$([ $EXIT_CODE -eq 0 ] && echo completed || echo failed)'","squad":"${config.squad}","agent":"${config.agent}","executionId":"${config.executionId}","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","exitCode":'$EXIT_CODE'}' > '${eventsDir}/pending/${config.executionId}-${config.agent}.json'; \\
tmux kill-session -t ${config.sessionName} 2>/dev/null
`.trim().replace(/\n/g, ' ');
}

/**
 * Build the lead agent prompt that includes orchestration capabilities
 */
export function buildLeadPrompt(config: {
  squad: string;
  lead: string;
  projectRoot: string;
  agents: string[];
}): string {
  // Keep prompt short - Claude will read detailed instructions from files
  return `You are ${config.lead}, orchestrating the ${config.squad} squad.

Read .agents/squads/${config.squad}/SQUAD.md for goals.
Read .agents/squads/${config.squad}/${config.lead}.md for your instructions.

Workers: ${config.agents.slice(0, 5).join(', ')}${config.agents.length > 5 ? ` (+${config.agents.length - 5} more)` : ''}

To spawn workers: squads run ${config.squad}/<agent> --execute --background
Check events: ls .agents/events/pending/
Review output: cat .agents/memory/${config.squad}/<agent>/state.md

When done: git add .agents/ && git commit -m "feat(${config.squad}): orchestration complete" && git push && /exit`.trim();
}

/**
 * Watch for worker completion events (for real-time notification)
 */
export function watchForEvents(
  eventsDir: string,
  callback: (event: WorkerEvent) => void
): () => void {
  const pendingDir = join(eventsDir, 'pending');

  const watcher = watch(pendingDir, (eventType, filename) => {
    if (eventType === 'rename' && filename?.endsWith('.json')) {
      const filepath = join(pendingDir, filename);
      if (existsSync(filepath)) {
        try {
          const content = readFileSync(filepath, 'utf-8');
          const event = JSON.parse(content) as WorkerEvent;
          callback(event);
        } catch {
          // Ignore parse errors
        }
      }
    }
  });

  // Return cleanup function
  return () => watcher.close();
}
