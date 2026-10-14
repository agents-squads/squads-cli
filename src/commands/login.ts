import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import {
  isAuthConfigured,
  getEmailDomain,
  saveSession,
  loadSession,
  clearSession,
  startAuthCallbackServer,
  AuthSession
} from '../lib/auth.js';
import { track } from '../lib/telemetry.js';
import { writeLine } from '../lib/terminal.js';

const CALLBACK_PORT = 54321;

async function isAuthEndpointAvailable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

export async function loginCommand(): Promise<void> {
  // The auth endpoint is not deployed yet. Hide the login surface rather than
  // probing an empty URL and degrading to a "Coming Soon" waitlist (#1208).
  // Read at call time so tests/processes that set the env after import are honored.
  if (!isAuthConfigured()) {
    writeLine('Cloud login is not available in this build.');
    return;
  }

  const existingSession = loadSession();

  if (existingSession && existingSession.status === 'active') {
    writeLine(chalk.green(`✓ Already logged in as ${existingSession.email}`));
    writeLine(chalk.dim(`  Domain: ${existingSession.domain}`));
    writeLine(chalk.dim(`  Run 'squads logout' to sign out.`));
    return;
  }

  // Check if auth endpoint is available
  const url = process.env.SQUADS_AUTH_URL || '';
  const spinner = ora('Checking authentication service...').start();
  const isAvailable = await isAuthEndpointAvailable(url);

  if (!isAvailable) {
    spinner.stop();
    spinner.clear();
    writeLine(`
${chalk.bold.cyan('Pro & Enterprise Login')} ${chalk.yellow('(Coming Soon)')}
${chalk.dim('─'.repeat(40))}

Authentication is coming soon for Pro & Enterprise teams.

${chalk.bold('In the meantime:')}
  ${chalk.dim('→')} Explore the CLI: ${chalk.cyan('squads status')}
  ${chalk.dim('→')} Run agents: ${chalk.cyan('squads run <squad>')}
  ${chalk.dim('→')} Join waitlist: ${chalk.cyan('https://agents-squads.com/waitlist')}

${chalk.dim('Questions?')} ${chalk.cyan('hello@agents-squads.com')}
`);
    await track('cli.login.unavailable');
    return;
  }

  spinner.text = 'Opening browser to authenticate...';
  spinner.succeed();

  writeLine(`
${chalk.bold.magenta('Squads CLI Login')}
${chalk.dim('─'.repeat(40))}
`);

  const authSpinner = ora('Waiting for authentication...').start();

  try {
    // Start local callback server
    const callbackPromise = startAuthCallbackServer(CALLBACK_PORT);

    // Open browser to auth page
    const authPageUrl = `${url}?callback=http://localhost:${CALLBACK_PORT}/callback`;
    await open(authPageUrl);

    // Wait for callback
    const { email, token } = await callbackPromise;

    // Save active session. All authenticated signups are accepted — segmentation
    // of signups is a server-side concern, not a CLI gate (#1208).
    const session: AuthSession = {
      email,
      domain: getEmailDomain(email),
      status: 'active',
      createdAt: new Date().toISOString(),
      accessToken: token,
    };

    saveSession(session);
    authSpinner.succeed(`Logged in as ${chalk.cyan(email)}`);

    await track('cli.login.success', { domain: session.domain });

    writeLine(`
${chalk.green('✓ You are logged in.')}

${chalk.dim('Get started:')}
  → Explore squads: ${chalk.cyan('squads status')}
  → Dispatch to cloud: ${chalk.cyan('squads run <squad>/<agent> --cloud')}

${chalk.dim('Questions? Email us at')} ${chalk.cyan('hello@agents-squads.com')}
`);

  } catch (error) {
    authSpinner.fail('Login failed');
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
  }
}

export async function logoutCommand(): Promise<void> {
  const session = loadSession();

  if (!session) {
    writeLine(chalk.yellow('Not logged in.'));
    return;
  }

  clearSession();
  writeLine(chalk.green(`✓ Logged out from ${session.email}`));
}

export async function whoamiCommand(): Promise<void> {
  const session = loadSession();

  if (!session) {
    writeLine(chalk.yellow('Not logged in.'));
    writeLine(chalk.dim('Run: squads login'));
    return;
  }

  writeLine(`
${chalk.bold('Current Session')}
${chalk.dim('─'.repeat(30))}
Email:   ${chalk.cyan(session.email)}
Domain:  ${session.domain}
Status:  ${session.status === 'active' ? chalk.green('Active') : chalk.yellow('Pending')}
Since:   ${new Date(session.createdAt).toLocaleDateString()}
`);
}
