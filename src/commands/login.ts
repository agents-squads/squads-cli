import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import {
  isPersonalEmail,
  getEmailDomain,
  saveSession,
  loadSession,
  clearSession,
  startAuthCallbackServer,
  AuthSession
} from '../lib/auth.js';
import { track } from '../lib/telemetry.js';

const AUTH_URL = process.env.SQUADS_AUTH_URL || 'https://app.agents-squads.com/auth';
const CALLBACK_PORT = 54321;

async function isAuthEndpointAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(AUTH_URL, {
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
  const existingSession = loadSession();

  if (existingSession && existingSession.status === 'active') {
    console.log(chalk.green(`✓ Already logged in as ${existingSession.email}`));
    console.log(chalk.dim(`  Domain: ${existingSession.domain}`));
    console.log(chalk.dim(`  Run 'squads logout' to sign out.`));
    return;
  }

  // Check if auth endpoint is available
  const spinner = ora('Checking authentication service...').start();
  const isAvailable = await isAuthEndpointAvailable();

  if (!isAvailable) {
    spinner.stop();
    spinner.clear();
    console.log(`
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

  console.log(`
${chalk.bold.magenta('Squads CLI Login')}
${chalk.dim('─'.repeat(40))}
`);

  const authSpinner = ora('Waiting for authentication...').start();

  try {
    // Start local callback server
    const callbackPromise = startAuthCallbackServer(CALLBACK_PORT);

    // Open browser to auth page
    const authUrl = `${AUTH_URL}?callback=http://localhost:${CALLBACK_PORT}/callback`;
    await open(authUrl);

    // Wait for callback
    const { email, token } = await callbackPromise;

    // Check if personal email
    if (isPersonalEmail(email)) {
      authSpinner.fail('Personal emails not supported');
      console.log(`
${chalk.yellow('⚠ Squads CLI is for Pro & Enterprise teams only.')}

Personal email domains (Gmail, Yahoo, etc.) are not supported.

${chalk.dim('Want to stay updated?')}
  → Get our free research report: ${chalk.cyan('https://agents-squads.com/research')}
  → Follow us: ${chalk.cyan('https://x.com/agents_squads')}
`);

      await track('cli.login.personal_email', { domain: getEmailDomain(email) });
      return;
    }

    // Save session
    const session: AuthSession = {
      email,
      domain: getEmailDomain(email),
      status: 'pending', // Will be 'active' after sales contact
      createdAt: new Date().toISOString(),
      accessToken: token,
    };

    saveSession(session);
    authSpinner.succeed(`Logged in as ${chalk.cyan(email)}`);

    await track('cli.login.success', { domain: session.domain });

    console.log(`
${chalk.green('✓ Thanks for signing up!')}

${chalk.bold('What happens next:')}
  1. Our team will reach out within 24 hours
  2. We'll discuss your AI agent needs
  3. You'll get access to Pro features

${chalk.dim('In the meantime:')}
  → Explore squads: ${chalk.cyan('squads status')}
  → Set goals: ${chalk.cyan('squads goal set <squad> "<goal>"')}
  → Read our research: ${chalk.cyan('https://agents-squads.com/research')}

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
    console.log(chalk.yellow('Not logged in.'));
    return;
  }

  clearSession();
  console.log(chalk.green(`✓ Logged out from ${session.email}`));
  await track('cli.logout');
}

export async function whoamiCommand(): Promise<void> {
  const session = loadSession();

  if (!session) {
    console.log(chalk.yellow('Not logged in.'));
    console.log(chalk.dim('Run: squads login'));
    return;
  }

  console.log(`
${chalk.bold('Current Session')}
${chalk.dim('─'.repeat(30))}
Email:   ${chalk.cyan(session.email)}
Domain:  ${session.domain}
Status:  ${session.status === 'active' ? chalk.green('Active') : chalk.yellow('Pending')}
Since:   ${new Date(session.createdAt).toLocaleDateString()}
`);
}
