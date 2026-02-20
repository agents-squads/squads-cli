/**
 * Permission Engine for Squad Execution
 *
 * Phase 3 of the Squads as Execution Contexts RFC (#110)
 *
 * Validates execution requests against squad-defined permissions:
 * - Bash command allowlists
 * - File path permissions (read/write globs)
 * - MCP server allow/deny lists
 *
 * Supports three enforcement modes:
 * - warn: Log violations, continue execution
 * - strict: Block on any violation
 * - audit: Log to trail, continue execution
 */

import { minimatch } from 'minimatch';

export type EnforcementMode = 'warn' | 'strict' | 'audit';

/**
 * Squad context for permission validation
 * Populated from SQUAD.md context YAML block (Phase 1)
 */
export interface SquadContext {
  squad: string;
  agent?: string;

  permissions: {
    mode: EnforcementMode;
    bash: string[];          // Allowed bash commands (e.g., ['npm', 'git', 'vercel'])
    write: string[];         // Write path globs (e.g., ['agents-squads-web/**'])
    read: string[];          // Read path globs (e.g., ['hq/.agents/**'])
    mcp: {
      allow: string[];       // Allowed MCP servers
      deny: string[];        // Denied MCP servers (takes precedence)
    };
  };
}

/**
 * Execution request to validate
 */
export interface ExecutionRequest {
  // Bash commands the agent might run
  bashCommands?: string[];

  // File paths to write
  writePaths?: string[];

  // File paths to read
  readPaths?: string[];

  // MCP servers to use
  mcpServers?: string[];
}

/**
 * Result of permission validation
 */
export interface PermissionResult {
  allowed: boolean;
  violations: PermissionViolation[];
  mode: EnforcementMode;
}

/**
 * Details of a permission violation
 */
export interface PermissionViolation {
  type: 'bash' | 'write' | 'read' | 'mcp';
  requested: string;
  reason: string;
  severity: 'error' | 'warning';
}

/**
 * Default permissive context for squads without explicit permissions
 */
export function getDefaultContext(squad: string, agent?: string): SquadContext {
  return {
    squad,
    agent,
    permissions: {
      mode: 'warn',
      bash: ['*'],           // All commands allowed by default
      write: ['**'],         // All paths writable by default
      read: ['**'],          // All paths readable by default
      mcp: {
        allow: ['*'],        // All MCP servers allowed
        deny: []
      }
    }
  };
}

/**
 * Check if a bash command is allowed
 */
function validateBashCommand(
  command: string,
  allowedCommands: string[]
): PermissionViolation | null {
  // Extract the base command (first word)
  const baseCommand = command.trim().split(/\s+/)[0];

  // Check if wildcard allows all
  if (allowedCommands.includes('*')) {
    return null;
  }

  // Check if command is in allowlist
  const isAllowed = allowedCommands.some(allowed => {
    if (allowed === baseCommand) return true;
    // Support glob patterns
    if (allowed.includes('*')) {
      return minimatch(baseCommand, allowed);
    }
    return false;
  });

  if (!isAllowed) {
    return {
      type: 'bash',
      requested: baseCommand,
      reason: `Bash command '${baseCommand}' not in allowlist: [${allowedCommands.join(', ')}]`,
      severity: 'error'
    };
  }

  return null;
}

/**
 * Check if a file path matches any of the allowed globs
 */
function validateFilePath(
  path: string,
  allowedGlobs: string[],
  operation: 'read' | 'write'
): PermissionViolation | null {
  // Wildcard allows all
  if (allowedGlobs.includes('**') || allowedGlobs.includes('*')) {
    return null;
  }

  // Check against each glob
  const isAllowed = allowedGlobs.some(glob => minimatch(path, glob));

  if (!isAllowed) {
    return {
      type: operation,
      requested: path,
      reason: `${operation === 'write' ? 'Write' : 'Read'} to '${path}' not allowed. Permitted paths: [${allowedGlobs.join(', ')}]`,
      severity: 'error'
    };
  }

  return null;
}

/**
 * Check if an MCP server is allowed
 */
function validateMcpServer(
  server: string,
  allow: string[],
  deny: string[]
): PermissionViolation | null {
  // Deny list takes precedence
  const isDenied = deny.some(pattern => {
    if (pattern === server) return true;
    if (pattern.includes('*')) return minimatch(server, pattern);
    return false;
  });

  if (isDenied) {
    return {
      type: 'mcp',
      requested: server,
      reason: `MCP server '${server}' is explicitly denied`,
      severity: 'error'
    };
  }

  // Check allow list
  if (allow.includes('*')) {
    return null;
  }

  const isAllowed = allow.some(pattern => {
    if (pattern === server) return true;
    if (pattern.includes('*')) return minimatch(server, pattern);
    return false;
  });

  if (!isAllowed) {
    return {
      type: 'mcp',
      requested: server,
      reason: `MCP server '${server}' not in allowlist: [${allow.join(', ')}]`,
      severity: 'error'
    };
  }

  return null;
}

/**
 * Main validation function
 *
 * Validates an execution request against the squad's permission context
 */
export function validateExecution(
  context: SquadContext,
  request: ExecutionRequest
): PermissionResult {
  const violations: PermissionViolation[] = [];

  // Validate bash commands
  if (request.bashCommands) {
    for (const cmd of request.bashCommands) {
      const violation = validateBashCommand(cmd, context.permissions.bash);
      if (violation) {
        violations.push(violation);
      }
    }
  }

  // Validate write paths
  if (request.writePaths) {
    for (const path of request.writePaths) {
      const violation = validateFilePath(path, context.permissions.write, 'write');
      if (violation) {
        violations.push(violation);
      }
    }
  }

  // Validate read paths
  if (request.readPaths) {
    for (const path of request.readPaths) {
      const violation = validateFilePath(path, context.permissions.read, 'read');
      if (violation) {
        violations.push(violation);
      }
    }
  }

  // Validate MCP servers
  if (request.mcpServers) {
    for (const server of request.mcpServers) {
      const violation = validateMcpServer(
        server,
        context.permissions.mcp.allow,
        context.permissions.mcp.deny
      );
      if (violation) {
        violations.push(violation);
      }
    }
  }

  // Determine if execution is allowed based on mode
  const hasErrors = violations.some(v => v.severity === 'error');
  const allowed = context.permissions.mode !== 'strict' || !hasErrors;

  return {
    allowed,
    violations,
    mode: context.permissions.mode
  };
}

/**
 * Format violations for display
 */
export function formatViolations(result: PermissionResult): string[] {
  const lines: string[] = [];

  if (result.violations.length === 0) {
    return lines;
  }

  const modeLabel = {
    warn: '⚠️  PERMISSION WARNING',
    strict: '🚫 PERMISSION DENIED',
    audit: '📝 PERMISSION AUDIT'
  }[result.mode];

  lines.push(modeLabel);
  lines.push('');

  for (const v of result.violations) {
    const icon = v.severity === 'error' ? '✗' : '⚠';
    lines.push(`  ${icon} [${v.type}] ${v.reason}`);
  }

  if (result.mode === 'warn') {
    lines.push('');
    lines.push('  Continuing with warnings (mode: warn)');
  } else if (result.mode === 'audit') {
    lines.push('');
    lines.push('  Logged for audit, continuing (mode: audit)');
  } else if (!result.allowed) {
    lines.push('');
    lines.push('  Execution blocked (mode: strict)');
  }

  return lines;
}

/**
 * Parse permissions YAML block from SQUAD.md content
 *
 * Expected format in SQUAD.md:
 * ```yaml
 * permissions:
 *   mode: warn | strict | audit
 *   bash: [npm, git, vercel]
 *   write: [agents-squads-web/**]
 *   read: [hq/.agents/**]
 *   mcp:
 *     allow: [chrome-devtools, firecrawl]
 *     deny: [restricted-server]
 * ```
 */
export function parsePermissionsYaml(content: string): Partial<SquadContext['permissions']> | null {
  // Find YAML code block
  const yamlMatch = content.match(/```ya?ml\n([\s\S]*?)```/);
  if (!yamlMatch) return null;

  const yamlContent = yamlMatch[1];

  // Simple YAML parsing for permissions block
  const permissions: Partial<SquadContext['permissions']> = {};

  // Parse mode
  const modeMatch = yamlContent.match(/^\s*mode:\s*(warn|strict|audit)/m);
  if (modeMatch) {
    permissions.mode = modeMatch[1] as EnforcementMode;
  }

  // Parse bash allowlist
  const bashMatch = yamlContent.match(/^\s*bash:\s*\[(.*?)\]/m);
  if (bashMatch) {
    permissions.bash = bashMatch[1].split(',').map(s => s.trim());
  }

  // Parse write globs
  const writeMatch = yamlContent.match(/^\s*write:\s*\[(.*?)\]/m);
  if (writeMatch) {
    permissions.write = writeMatch[1].split(',').map(s => s.trim());
  }

  // Parse read globs
  const readMatch = yamlContent.match(/^\s*read:\s*\[(.*?)\]/m);
  if (readMatch) {
    permissions.read = readMatch[1].split(',').map(s => s.trim());
  }

  // Parse MCP allow/deny
  const mcpAllowMatch = yamlContent.match(/^\s*allow:\s*\[(.*?)\]/m);
  const mcpDenyMatch = yamlContent.match(/^\s*deny:\s*\[(.*?)\]/m);

  if (mcpAllowMatch || mcpDenyMatch) {
    permissions.mcp = {
      allow: mcpAllowMatch ? mcpAllowMatch[1].split(',').map(s => s.trim()) : ['*'],
      deny: mcpDenyMatch ? mcpDenyMatch[1].split(',').map(s => s.trim()) : []
    };
  }

  return Object.keys(permissions).length > 0 ? permissions : null;
}

/**
 * Build a SquadContext from SQUAD.md content
 */
export function buildContextFromSquad(
  squadName: string,
  squadContent: string,
  agentName?: string
): SquadContext {
  // Start with defaults
  const context = getDefaultContext(squadName, agentName);

  // Parse permissions from content
  const parsed = parsePermissionsYaml(squadContent);

  if (parsed) {
    if (parsed.mode) context.permissions.mode = parsed.mode;
    if (parsed.bash) context.permissions.bash = parsed.bash;
    if (parsed.write) context.permissions.write = parsed.write;
    if (parsed.read) context.permissions.read = parsed.read;
    if (parsed.mcp) context.permissions.mcp = parsed.mcp;
  }

  return context;
}
