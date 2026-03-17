/**
 * Cloud worker dispatch and polling.
 * Extracted from src/commands/run.ts to reduce its size.
 */

import ora from 'ora';
import { loadSession, isLoggedIn } from './auth.js';
import { getApiUrl } from './env-config.js';
import { colors, RESET, icons, writeLine } from './terminal.js';
import { type RunOptions } from './run-types.js';

const CLOUD_POLL_INTERVAL_MS = 3000;
const CLOUD_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max poll

/**
 * Dispatch agent execution to cloud worker via API.
 * Posts to /agent-dispatch, then polls /agent-executions for status.
 */
export async function runCloudDispatch(
  squadName: string,
  agentName: string,
  options: RunOptions
): Promise<void> {
  const apiUrl = getApiUrl();

  if (!apiUrl) {
    writeLine(`  ${colors.red}${icons.error} API URL not configured${RESET}`);
    writeLine(`  ${colors.dim}Run: squads config use staging  (or set SQUADS_API_URL)${RESET}`);
    process.exit(1);
  }

  // Require auth session
  if (!isLoggedIn()) {
    writeLine(`  ${colors.red}${icons.error} Not logged in${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads login\` to authenticate before using --cloud${RESET}`);
    process.exit(1);
  }

  const session = loadSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Use access token if available, otherwise use API key
  if (session?.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  }

  const apiKey = process.env.SQUADS_PLATFORM_API_TOKEN || process.env.SCHEDULER_API_KEY;
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const spinner = ora(`Dispatching ${squadName}/${agentName} to cloud...`).start();

  try {
    // 1. Create dispatch request
    const dispatchRes = await fetch(`${apiUrl}/agent-dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        squad: squadName,
        agent: agentName,
        trigger_type: 'manual',
        trigger_data: {
          source: 'cli',
          cloud: true,
          model: options.model,
          provider: options.provider,
          effort: options.effort,
        },
      }),
    });

    if (!dispatchRes.ok) {
      const error = await dispatchRes.text();
      spinner.fail(`Dispatch failed: ${dispatchRes.status}`);
      writeLine(`  ${colors.dim}${error}${RESET}`);
      process.exit(1);
    }

    const dispatch = await dispatchRes.json() as { dispatch_id: number; status: string };
    spinner.succeed(`Dispatched to cloud`);

    writeLine();
    writeLine(`  ${colors.cyan}Dispatch ID${RESET}  ${dispatch.dispatch_id}`);
    writeLine(`  ${colors.cyan}Squad${RESET}        ${squadName}`);
    writeLine(`  ${colors.cyan}Agent${RESET}        ${agentName}`);
    writeLine();

    // 2. Poll for execution status
    const pollSpinner = ora('Waiting for execution to start...').start();
    const pollStart = Date.now();
    let executionId: string | null = null;
    let lastStatus = '';

    while (Date.now() - pollStart < CLOUD_POLL_TIMEOUT_MS) {
      try {
        const execRes = await fetch(
          `${apiUrl}/agent-executions?squad=${encodeURIComponent(squadName)}&agent=${encodeURIComponent(agentName)}&limit=1`,
          { headers },
        );

        if (execRes.ok) {
          const executions = await execRes.json() as Array<{
            execution_id: string;
            status: string;
            summary?: string;
            error?: string;
            duration_seconds?: number;
            cost_usd?: number;
          }>;

          if (executions.length > 0) {
            const exec = executions[0];

            // Only track executions started after our dispatch
            if (!executionId && exec.status === 'running') {
              executionId = exec.execution_id;
              pollSpinner.text = `Running (${exec.execution_id})`;
            }

            if (executionId && exec.execution_id === executionId) {
              if (exec.status !== lastStatus) {
                lastStatus = exec.status;
                pollSpinner.text = `Status: ${exec.status}`;
              }

              if (exec.status === 'completed') {
                pollSpinner.succeed('Execution completed');
                writeLine();
                writeLine(`  ${colors.cyan}Execution${RESET}    ${exec.execution_id}`);
                if (exec.summary) {
                  writeLine(`  ${colors.cyan}Summary${RESET}      ${exec.summary}`);
                }
                if (exec.duration_seconds) {
                  writeLine(`  ${colors.cyan}Duration${RESET}     ${Math.round(exec.duration_seconds)}s`);
                }
                if (exec.cost_usd) {
                  writeLine(`  ${colors.cyan}Cost${RESET}         $${exec.cost_usd.toFixed(4)}`);
                }
                writeLine();
                return;
              }

              if (exec.status === 'failed') {
                pollSpinner.fail('Execution failed');
                writeLine();
                if (exec.error) {
                  writeLine(`  ${colors.red}Error: ${exec.error}${RESET}`);
                }
                writeLine();
                process.exit(1);
              }

              if (exec.status === 'cancelled') {
                pollSpinner.warn('Execution cancelled');
                return;
              }
            }
          }
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: cloud poll failed (retrying): ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }

      await new Promise(resolve => setTimeout(resolve, CLOUD_POLL_INTERVAL_MS));
    }

    pollSpinner.warn('Poll timeout — execution may still be running');
    writeLine(`  ${colors.dim}Check status: squads trigger status${RESET}`);
    if (executionId) {
      writeLine(`  ${colors.dim}Execution ID: ${executionId}${RESET}`);
    }
  } catch (error) {
    spinner.fail('Cloud dispatch failed');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Check your network and SQUADS_API_URL setting${RESET}`);
    process.exit(1);
  }
}
