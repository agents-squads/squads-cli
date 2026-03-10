import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Run each test file in an isolated forked subprocess.
    // Prevents process.env mutations (GIT_DIR deletions in E2E beforeAll hooks)
    // from leaking across concurrently-running test files. Fixes #578.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'], // CLI entry point tested via integration
    },
    testTimeout: 10000,
  },
});
