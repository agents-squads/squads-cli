import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import http from 'http';

// Personal email domains to reject
const PERSONAL_DOMAINS = [
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me',
  'zoho.com',
  'mail.com',
  'yandex.com', 'yandex.ru',
  'gmx.com', 'gmx.de',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
];

const AUTH_DIR = join(homedir(), '.squads-cli');
const AUTH_PATH = join(AUTH_DIR, 'auth.json');

export interface AuthSession {
  email: string;
  domain: string;
  status: 'pending' | 'contacted' | 'active';
  createdAt: string;
  accessToken?: string;
}

export function isPersonalEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return PERSONAL_DOMAINS.includes(domain);
}

export function getEmailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() || '';
}

export function saveSession(session: AuthSession): void {
  if (!existsSync(AUTH_DIR)) {
    mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(AUTH_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function loadSession(): AuthSession | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    if (existsSync(AUTH_PATH)) {
      unlinkSync(AUTH_PATH);
    }
  } catch {
    // File already removed or inaccessible
  }
}

export function isLoggedIn(): boolean {
  const session = loadSession();
  return session !== null && session.status === 'active';
}

export interface VerifiedUser {
  email: string;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  status: string;
}

// Verify a token against the API and return user data (null on failure)
export async function verifyToken(apiUrl: string, token: string): Promise<VerifiedUser | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiUrl}/auth/cli/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return {
      email: String(data.email ?? ''),
      tenantId: Number(data.tenant_id ?? 0),
      tenantSlug: String(data.tenant_slug ?? ''),
      tenantName: String(data.tenant_name ?? ''),
      status: String(data.status ?? ''),
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// Escape HTML special characters to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Local callback server for OAuth flow
export function startAuthCallbackServer(port: number = 54321): Promise<{ email: string; token: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);

      if (url.pathname === '/callback') {
        const email = url.searchParams.get('email');
        const token = url.searchParams.get('token');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                  <h1 style="color: #ef4444;">Authentication failed: ${escapeHtml(error)}</h1>
                  <p>You can close this window.</p>
                </div>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(error));
          return;
        }

        if (email && token) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                  <h1 style="color: #10b981;">Logged in!</h1>
                  <p>Welcome, ${escapeHtml(email)}</p>
                  <p style="color: #6b7280;">You can close this window and return to your terminal.</p>
                </div>
              </body>
            </html>
          `);
          server.close();
          resolve({ email, token });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing email or token');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      // Server started
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out'));
    }, 5 * 60 * 1000);
  });
}
