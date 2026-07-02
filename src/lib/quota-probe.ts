/**
 * Quota probe — cheap pre-flight check of the Claude session window.
 *
 * The org runner dispatches every squad in parallel; launching into an
 * exhausted Max 5h window burns the whole cycle on "hit your session limit"
 * turns (squads-cli#856, live evidence 2026-06-11). A 1-prompt haiku ping
 * (~$0.0001) before dispatch tells us whether the window is open.
 */
import { spawn } from 'child_process';
import { isQuotaMessage } from './conversation.js';

export interface QuotaProbeResult {
  /** True when the session window is exhausted */
  capped: boolean;
  /** Human-readable reset hint extracted from the limit message, e.g. "3:10am (America/Santiago)" */
  resetHint?: string;
  /** First chars of the raw response (diagnostics) */
  raw: string;
}

/** Extract the reset time from a limit message like "hit your session limit · resets 3:10am (America/Santiago)" */
export function extractResetHint(text: string): string | undefined {
  const m = text.match(/resets?\s+(?:at\s+)?([^\n]+)/i);
  return m ? m[1].trim() : undefined;
}

/**
 * Probe the quota window with a minimal haiku call.
 * Fails OPEN (capped: false) on timeout or spawn error — a broken probe must
 * never block real work; the per-turn quota sentinels still catch a cap.
 */
export function probeQuota(timeoutMs = 90_000): Promise<QuotaProbeResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['--print', '--model', 'haiku', '--disable-slash-commands'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ capped: false, raw: '[probe spawn failed]' });
      return;
    }

    let out = '';
    let done = false;
    const finish = (result: QuotaProbeResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ capped: false, raw: '[probe timeout]' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ capped: false, raw: '[probe spawn failed]' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const capped = isQuotaMessage(out);
      finish({
        capped,
        resetHint: capped ? extractResetHint(out) : undefined,
        raw: out.slice(0, 200),
      });
    });

    child.stdin.write('Reply with exactly: ok');
    child.stdin.end();
  });
}

/**
 * Poll until the quota window reopens. Polling beats parsing the reset
 * timestamp: "resets 3:10am (America/Santiago)" is locale/timezone-dependent
 * and the format is not a contract. Each poll is one haiku ping.
 *
 * Returns true when the window opened, false when maxWaitMs elapsed.
 */
export async function waitForQuota(opts: {
  pollMs?: number;
  maxWaitMs?: number;
  onPoll?: (probe: QuotaProbeResult, waitedMs: number) => void;
} = {}): Promise<boolean> {
  const pollMs = opts.pollMs ?? 10 * 60_000;      // 10 min between pings
  const maxWaitMs = opts.maxWaitMs ?? 6 * 60 * 60_000; // 6h cap (> one full 5h window)
  let waited = 0;
  while (waited < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    waited += pollMs;
    const probe = await probeQuota();
    opts.onPoll?.(probe, waited);
    if (!probe.capped) return true;
  }
  return false;
}
