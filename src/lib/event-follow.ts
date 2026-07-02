/**
 * event-follow.ts — live follower for a detached run's stream-json log (#903).
 *
 * Since #902, a detached claude run's logfile is a live JSONL event stream.
 * This follows the file as it grows (poll + append-read; no fs.watch — it is
 * unreliable across editors/volumes on macOS), pipes each complete line
 * through the provider adapter, and renders the human feed. Replaces the raw
 * `tail -f` in watch mode, which since #902 would show unreadable JSON.
 *
 * End-of-run detection: the detached wrapper removes its pid file on exit —
 * when the pid file is gone and no bytes remain unread, the run is over.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { createClaudeStreamJsonAdapter } from './exec-events.js';
import { renderEvent } from './event-render.js';
import { writeLine } from './terminal.js';

const DEFAULT_POLL_MS = 400;

export interface FollowHandle {
  /** Stop following (the run itself continues). Resolves `done`. */
  stop: () => void;
  /** Resolves when the run ends (pid file gone, log drained) or stop() is called. */
  done: Promise<void>;
}

/**
 * Follow a live stream-json log, rendering events as they land.
 * Set SQUADS_WATCH_RAW=1 to pass raw lines through instead of rendering.
 */
export function followProviderLog(
  logFile: string,
  opts: { pidFile?: string; pollMs?: number; onLine?: (rendered: string) => void } = {},
): FollowHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const emit = opts.onLine ?? ((line: string) => writeLine(`  ${line}`));
  const raw = process.env.SQUADS_WATCH_RAW === '1';
  const adapter = createClaudeStreamJsonAdapter();

  let offset = 0;
  let buf = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    if (raw) {
      emit(line);
      return;
    }
    let events;
    try {
      events = adapter.parseLine(line);
    } catch {
      return;
    }
    for (const event of events) {
      const rendered = renderEvent(event);
      if (rendered !== null) emit(rendered);
    }
  };

  const readAppended = (): boolean => {
    // Returns true when new bytes were consumed.
    let size: number;
    try {
      size = statSync(logFile).size;
    } catch {
      return false; // not created yet — keep waiting
    }
    if (size < offset) offset = 0; // truncated/rotated — start over
    if (size === offset) return false;
    try {
      const fd = openSync(logFile, 'r');
      try {
        const chunk = Buffer.alloc(size - offset);
        const read = readSync(fd, chunk, 0, chunk.length, offset);
        offset += read;
        buf += chunk.toString('utf8', 0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    return true;
  };

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    // Drain whatever is left, including a final partial line.
    readAppended();
    if (buf) {
      consumeLine(buf);
      buf = '';
    }
    resolveDone();
  };

  const tick = (): void => {
    if (stopped) return;
    const gotBytes = readAppended();
    // Run over? pid file removed by the wrapper on exit, and log fully drained.
    if (!gotBytes && opts.pidFile && !existsSync(opts.pidFile)) {
      finish();
      return;
    }
    timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, 0);

  return { stop: finish, done };
}
