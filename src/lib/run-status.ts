/**
 * Terminal run status from evidence (#1321).
 *
 * `run.status` must say what the evidence says, not what the process exit code
 * says. Three shapes lied before this module:
 *
 *  - a Claude-harness lane whose stream-json result was
 *    `{"subtype":"success","is_error":true,"terminal_reason":"api_error"}` —
 *    the row said running until a reconcile;
 *  - a Kimi lane that died on `provider.api_error: 429 …` while the wrapper
 *    exited 0 — the row said completed;
 *  - a lane that died inside its first second on an error line — the reaper
 *    called it orphaned and lost the cause.
 *
 * This is the one decision point for "what is this run's terminal state?",
 * layered on the typed provider classifier (#1298): provider evidence gives a
 * typed cause; otherwise a terminal is_error / missing result / harness error
 * line / non-zero exit / dead process gives an honest structural cause.
 *
 * Pure functions, no I/O — callers pass the log tail they already read.
 */
import {
  classifyFailedRun,
  extractProviderError,
  type ProviderError,
  type ProviderErrorType,
} from './provider-errors.js';

/** Provider causes, minus `unknown` (the classifier returns null for that). */
type ProviderCause = Exclude<ProviderErrorType, 'unknown'>;

/** Every terminal failure cause a ledger row can carry. */
export type FailureCause =
  | ProviderCause
  | 'harness_error'
  | 'interrupted'
  | 'nonzero_exit'
  | 'timeout'
  | 'orphaned';

export interface TerminalEvidence {
  provider?: string;
  /** The log is a structured stream, so its raw tail is agent prose. */
  structured?: boolean;
  /** Terminal `result` text — read only when `resultIsError`. */
  resultText?: string;
  resultIsError?: boolean;
  /** A detected fatal-signature line. */
  fatal?: string | null;
  stderr?: string;
  /** Tail of the executor log. */
  rawTail?: string;
  /** The stream ended without a terminal result. */
  missingTerminalResult?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  /** The process is gone and left no terminal report (reconcile path). */
  processGone?: boolean;
  /** The run is already known failed; lets the caller scan a plain-text tail. */
  knownFailed?: boolean;
}

export interface TerminalClassification {
  status: 'failed' | 'timeout' | 'orphaned';
  cause: FailureCause;
  message: string;
  providerError?: ProviderError;
}

/**
 * The last line that looks like the harness itself failed. Bounded to the tail
 * so an error a tool printed early in a long run, then recovered from, never
 * makes a completed run failed. Stream-json lines start with `{`, so their
 * embedded prose cannot match.
 */
const HARNESS_ERROR_LINE = /^\s*(?:error|fatal|panic)\b\s*[:-]?/i;

export function lastHarnessErrorLine(text: string, windowLines = 20): string | null {
  if (!text) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const floor = Math.max(0, lines.length - windowLines);
  for (let i = lines.length - 1; i >= floor; i--) {
    if (HARNESS_ERROR_LINE.test(lines[i])) return lines[i].slice(0, 300);
  }
  return null;
}

/**
 * Drop the partial first line of a byte-capped tail. When a read starts in the
 * middle of a line, the fragment is not a line: a structured log whose tail
 * starts mid-JSON must not be misread as plain text (#1321 review F3).
 */
export function dropPartialFirstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

/** True when the first meaningful line is a JSON object (stream / event log). */
export function looksStructuredLog(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim());
  if (!first) return false;
  const trimmed = first.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide a run's terminal state from evidence. Returns null when there is no
 * terminal evidence — a clean stream/exit may keep its current status.
 *
 * Precedence:
 *   1. watchdog timeout,
 *   2. typed provider error (result text, fatal line, stderr, or a plain tail
 *      when the run is already known failed),
 *   3. terminal result with `is_error: true`,
 *   4. stream ended without a terminal result → interrupted,
 *   5. a terminal harness error line (last 1–2 lines; wider when the process
 *      is gone) → typed provider cause or harness_error,
 *   6. non-zero exit → nonzero_exit,
 *   7. dead process with no cause anywhere → orphaned.
 */
export function classifyTerminalStatus(evidence: TerminalEvidence): TerminalClassification | null {
  if (evidence.timedOut) {
    return {
      status: 'timeout',
      cause: 'timeout',
      message: 'detached run reaped by watchdog at its deadline',
    };
  }

  const providerError = classifyFailedRun({
    provider: evidence.provider,
    structured: evidence.structured ?? false,
    resultText: evidence.resultText,
    resultIsError: evidence.resultIsError,
    fatal: evidence.fatal,
    stderr: evidence.stderr,
    rawTail: evidence.knownFailed || evidence.processGone ? evidence.rawTail : undefined,
  });
  if (providerError) {
    return {
      status: 'failed',
      cause: providerError.type as ProviderCause,
      message: `${providerError.type}: ${providerError.message}`,
      providerError,
    };
  }

  if (evidence.resultIsError) {
    return {
      status: 'failed',
      cause: 'harness_error',
      message: `${evidence.provider ?? 'harness'} reported is_error on its terminal result`,
    };
  }

  if (evidence.missingTerminalResult) {
    return {
      status: 'failed',
      cause: 'interrupted',
      message: 'stream ended without a terminal result — likely interrupted mid-response',
    };
  }

  // Only a *terminal* harness line may flip a run that exited cleanly: the
  // last 1–2 lines. An error the agent printed then recovered from is activity,
  // not a cause (review F2). A dead process keeps the wider window so a lane
  // that died spanning a few lines still gets its real cause.
  const harnessLine = evidence.processGone
    ? lastHarnessErrorLine(evidence.rawTail ?? '')
    : lastHarnessErrorLine(evidence.rawTail ?? '', 2);
  if (harnessLine) {
    const typed = extractProviderError(evidence.provider, harnessLine);
    if (typed) {
      return {
        status: 'failed',
        cause: typed.type as ProviderCause,
        message: `${typed.type}: ${typed.message}`,
        providerError: typed,
      };
    }
    return {
      status: 'failed',
      cause: 'harness_error',
      message: `harness error: ${harnessLine}`,
    };
  }

  if (typeof evidence.exitCode === 'number' && evidence.exitCode !== 0) {
    return {
      status: 'failed',
      cause: 'nonzero_exit',
      message: `process exited with code ${evidence.exitCode}`,
    };
  }

  if (evidence.processGone) {
    return {
      status: 'orphaned',
      cause: 'orphaned',
      message: 'orphaned: process gone without a terminal report and no failure cause in its log',
    };
  }

  return null;
}

/** Operator-facing one-liner for a terminal cause (provider causes already have one). */
export function describeFailureCause(cause: FailureCause): string {
  switch (cause) {
    case 'timeout': return 'reaped at its deadline';
    case 'orphaned': return 'process gone without a terminal report';
    case 'interrupted': return 'interrupted mid-response';
    case 'nonzero_exit': return 'process exited non-zero';
    case 'harness_error': return 'harness reported an error';
    default: return cause;
  }
}
