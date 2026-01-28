import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts', // CLI entry point tested via integration
        'src/commands/**/*.ts', // Commands require integration testing
        'src/lib/dashboard/**/*.ts', // Dashboard requires DB connection
        'src/lib/anthropic.ts', // Requires API key
        'src/lib/db.ts', // Requires DB connection
        'src/lib/slack.ts', // Requires Slack tokens
        'src/lib/setup-checks.ts', // System-level checks
        'src/lib/templates.ts', // Template generation
        'src/lib/local.ts', // Local file operations
        'src/lib/llm-clis.ts', // LLM CLI detection
        'src/lib/permissions.ts', // System permissions
        'src/lib/ui.ts', // Interactive UI components
        'src/lib/update.ts', // Requires npm registry access
      ],
      thresholds: {
        // Core lib files threshold
        lines: 50,
        functions: 45,
        branches: 35,
        statements: 50,
      },
    },
    testTimeout: 10000,
  },
});
