import { defineConfig } from 'vitest/config';

// FAST=1 skips the Testcontainers integration tests (used by the pre-commit hook).
const fast = process.env.FAST === '1';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['{apps,packages}/**/*.test.ts'],
    exclude: ['**/node_modules/**', ...(fast ? ['**/*.integration.test.ts'] : [])],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['{apps,packages}/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        // Thin process entrypoints: wiring only, covered by the integration test through the code they call.
        '**/main.ts',
        'apps/worker/src/boards.ts',
        // The manual live smoke run: never run by tests or CI; its refusal rule is tested in smoke-guard.test.ts.
        'apps/worker/src/smoke.ts',
        // Schema files hold declarative table definitions only; the integration tests exercise them.
        'packages/*/src/schema.ts',
        // A fake Gmail server for tests of this and other packages.
        'packages/mail/src/testing.ts',
      ],
      thresholds: { statements: 80, lines: 80, functions: 80, branches: 70 },
    },
  },
});
