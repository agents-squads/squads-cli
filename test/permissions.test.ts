import { describe, it, expect } from 'vitest';
import {
  validateExecution,
  getDefaultContext,
  parsePermissionsYaml,
  formatViolations,
  buildContextFromSquad,
  type SquadContext,
  type ExecutionRequest,
  type PermissionResult,
} from '../src/lib/permissions.js';

describe('permissions', () => {
  describe('getDefaultContext', () => {
    it('creates permissive default context for a squad', () => {
      const context = getDefaultContext('test-squad');

      expect(context.squad).toBe('test-squad');
      expect(context.agent).toBeUndefined();
      expect(context.permissions.mode).toBe('warn');
      expect(context.permissions.bash).toEqual(['*']);
      expect(context.permissions.write).toEqual(['**']);
      expect(context.permissions.read).toEqual(['**']);
      expect(context.permissions.mcp.allow).toEqual(['*']);
      expect(context.permissions.mcp.deny).toEqual([]);
    });

    it('includes agent name when provided', () => {
      const context = getDefaultContext('test-squad', 'test-agent');

      expect(context.squad).toBe('test-squad');
      expect(context.agent).toBe('test-agent');
    });
  });

  describe('validateExecution', () => {
    describe('bash command validation', () => {
      it('allows all commands when bash is wildcard', () => {
        const context = getDefaultContext('test-squad');
        const request: ExecutionRequest = {
          bashCommands: ['npm install', 'git status', 'custom-command']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });

      it('blocks disallowed bash commands in strict mode', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['npm', 'git'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['rm -rf /']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].type).toBe('bash');
        expect(result.violations[0].requested).toBe('rm');
      });

      it('warns but allows disallowed commands in warn mode', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'warn',
            bash: ['npm', 'git'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['rm -rf /']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(1);
      });

      it('allows explicitly listed commands', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['npm', 'git', 'vercel'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['npm install', 'git commit', 'vercel deploy']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });

      it('extracts base command from full command string', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['npm'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['npm install --save-dev vitest']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });
    });

    describe('file path validation', () => {
      it('allows all paths when wildcards are used', () => {
        const context = getDefaultContext('test-squad');
        const request: ExecutionRequest = {
          writePaths: ['/any/path/file.ts'],
          readPaths: ['/another/path/file.js']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });

      it('blocks write to disallowed paths in strict mode', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['src/**', 'test/**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          writePaths: ['node_modules/package/file.js']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].type).toBe('write');
      });

      it('allows write to permitted paths', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['src/**', 'test/**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          writePaths: ['src/lib/utils.ts', 'test/utils.test.ts']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });

      it('blocks read from disallowed paths in strict mode', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['**'],
            read: ['src/**', 'docs/**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          readPaths: ['.env.secret']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].type).toBe('read');
      });
    });

    describe('MCP server validation', () => {
      it('allows all MCP servers when allow is wildcard', () => {
        const context = getDefaultContext('test-squad');
        const request: ExecutionRequest = {
          mcpServers: ['chrome-devtools', 'firecrawl', 'custom-server']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });

      it('blocks explicitly denied MCP servers', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: ['dangerous-server'] }
          }
        };
        const request: ExecutionRequest = {
          mcpServers: ['dangerous-server']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].type).toBe('mcp');
        expect(result.violations[0].reason).toContain('explicitly denied');
      });

      it('deny list takes precedence over allow list', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['server-a', 'server-b'], deny: ['server-b'] }
          }
        };
        const request: ExecutionRequest = {
          mcpServers: ['server-b']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].reason).toContain('explicitly denied');
      });

      it('blocks servers not in allow list', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['*'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['approved-server'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          mcpServers: ['unknown-server']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].reason).toContain('not in allowlist');
      });
    });

    describe('enforcement modes', () => {
      it('strict mode blocks on violations', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: ['npm'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['rm file.txt']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(false);
        expect(result.mode).toBe('strict');
      });

      it('warn mode allows despite violations', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'warn',
            bash: ['npm'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['rm file.txt']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.mode).toBe('warn');
        expect(result.violations).toHaveLength(1);
      });

      it('audit mode allows despite violations', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'audit',
            bash: ['npm'],
            write: ['**'],
            read: ['**'],
            mcp: { allow: ['*'], deny: [] }
          }
        };
        const request: ExecutionRequest = {
          bashCommands: ['rm file.txt']
        };

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.mode).toBe('audit');
        expect(result.violations).toHaveLength(1);
      });
    });

    describe('empty requests', () => {
      it('allows empty request', () => {
        const context: SquadContext = {
          squad: 'test-squad',
          permissions: {
            mode: 'strict',
            bash: [],
            write: [],
            read: [],
            mcp: { allow: [], deny: [] }
          }
        };
        const request: ExecutionRequest = {};

        const result = validateExecution(context, request);

        expect(result.allowed).toBe(true);
        expect(result.violations).toHaveLength(0);
      });
    });
  });

  describe('parsePermissionsYaml', () => {
    it('parses complete permissions block', () => {
      const content = `
# Squad Definition

\`\`\`yaml
permissions:
  mode: strict
  bash: [npm, git, vercel]
  write: [src/**, test/**]
  read: [docs/**]
  mcp:
    allow: [chrome-devtools, firecrawl]
    deny: [dangerous-server]
\`\`\`
`;

      const result = parsePermissionsYaml(content);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('strict');
      expect(result!.bash).toEqual(['npm', 'git', 'vercel']);
      expect(result!.write).toEqual(['src/**', 'test/**']);
      expect(result!.read).toEqual(['docs/**']);
      expect(result!.mcp).toEqual({
        allow: ['chrome-devtools', 'firecrawl'],
        deny: ['dangerous-server']
      });
    });

    it('parses partial permissions block', () => {
      const content = `
\`\`\`yaml
mode: warn
bash: [npm]
\`\`\`
`;

      const result = parsePermissionsYaml(content);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('warn');
      expect(result!.bash).toEqual(['npm']);
      expect(result!.write).toBeUndefined();
      expect(result!.read).toBeUndefined();
    });

    it('returns null for content without yaml block', () => {
      const content = `
# Just markdown, no yaml

This is regular text.
`;

      const result = parsePermissionsYaml(content);

      expect(result).toBeNull();
    });

    it('handles audit mode', () => {
      const content = `
\`\`\`yaml
mode: audit
\`\`\`
`;

      const result = parsePermissionsYaml(content);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('audit');
    });
  });

  describe('formatViolations', () => {
    it('returns empty array for no violations', () => {
      const result: PermissionResult = {
        allowed: true,
        violations: [],
        mode: 'warn'
      };

      const lines = formatViolations(result);

      expect(lines).toHaveLength(0);
    });

    it('formats warn mode violations', () => {
      const result: PermissionResult = {
        allowed: true,
        violations: [{
          type: 'bash',
          requested: 'rm',
          reason: "Bash command 'rm' not in allowlist",
          severity: 'error'
        }],
        mode: 'warn'
      };

      const lines = formatViolations(result);

      expect(lines.some(l => l.includes('WARNING'))).toBe(true);
      expect(lines.some(l => l.includes('Continuing with warnings'))).toBe(true);
    });

    it('formats strict mode violations', () => {
      const result: PermissionResult = {
        allowed: false,
        violations: [{
          type: 'write',
          requested: '/etc/passwd',
          reason: 'Write to /etc/passwd not allowed',
          severity: 'error'
        }],
        mode: 'strict'
      };

      const lines = formatViolations(result);

      expect(lines.some(l => l.includes('DENIED'))).toBe(true);
      expect(lines.some(l => l.includes('blocked'))).toBe(true);
    });

    it('formats audit mode violations', () => {
      const result: PermissionResult = {
        allowed: true,
        violations: [{
          type: 'mcp',
          requested: 'unknown-server',
          reason: 'MCP server not in allowlist',
          severity: 'error'
        }],
        mode: 'audit'
      };

      const lines = formatViolations(result);

      expect(lines.some(l => l.includes('AUDIT'))).toBe(true);
      expect(lines.some(l => l.includes('Logged for audit'))).toBe(true);
    });
  });

  describe('buildContextFromSquad', () => {
    it('returns default context when no permissions in content', () => {
      const content = `
# My Squad

Just some markdown content.
`;

      const context = buildContextFromSquad('my-squad', content, 'my-agent');

      expect(context.squad).toBe('my-squad');
      expect(context.agent).toBe('my-agent');
      expect(context.permissions.mode).toBe('warn');
      expect(context.permissions.bash).toEqual(['*']);
    });

    it('merges parsed permissions with defaults', () => {
      const content = `
# My Squad

\`\`\`yaml
mode: strict
bash: [npm, git]
\`\`\`
`;

      const context = buildContextFromSquad('my-squad', content);

      expect(context.permissions.mode).toBe('strict');
      expect(context.permissions.bash).toEqual(['npm', 'git']);
      // Defaults preserved for unspecified fields
      expect(context.permissions.write).toEqual(['**']);
      expect(context.permissions.read).toEqual(['**']);
    });
  });
});
