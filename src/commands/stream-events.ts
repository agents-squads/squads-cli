/**
 * `squads _stream-events` — hidden helper for detached-lane live events (#1353).
 *
 * Re-invoked from inside a detached wrapper (see buildLiveStreamShell): it
 * tails the lane's raw harness log as it grows and normalizes each JSONL line
 * through the harness adapter, appending the events to the run's events file
 * immediately. It exits when the wrapper touches the done-file (executor gone)
 * and the log is drained, so the spool written afterwards reconciles on top of
 * a complete stream.
 */

import { streamEventsFromLog, type StreamEventsHarness } from '../lib/event-follow.js';

export async function streamEventsCommand(options: {
  harness?: string;
  file?: string;
  runId?: string;
  provider?: string;
  agent?: string;
  log?: string;
  done?: string;
  pollMs?: number;
}): Promise<void> {
  const harness = options.harness as StreamEventsHarness | undefined;
  if (harness !== 'opencode' && harness !== 'kimi-code' && harness !== 'claude') {
    process.exit(1);
  }
  if (!options.file || !options.runId || !options.log || !options.done) {
    process.exit(1);
  }
  await streamEventsFromLog({
    harness,
    eventsFile: options.file,
    runId: options.runId,
    provider: options.provider,
    agent: options.agent,
    logFile: options.log,
    doneFile: options.done,
    ...(typeof options.pollMs === 'number' && options.pollMs > 0 ? { pollMs: options.pollMs } : {}),
  });
}
