import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['{apps,packages}/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      // Scoped to source that is actually implemented in S0. As more phases
      // land (scrapers, llm, worker queues), widen this include list.
      include: [
        'apps/api/src/**/*.ts',
        'apps/worker/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/db/src/**/*.ts',
        'packages/scrapers/src/**/*.ts',
        'packages/shared/src/**/*.ts',
      ],
      all: true,
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        'packages/db/src/schema/*.ts',
        'packages/db/drizzle/**',
        // Thin CLI entrypoint (wires config + logger + runMigrationsWithLock,
        // which is itself unit tested) — not worth mocking process.exit for.
        'packages/db/src/run-migrate.ts',
        // Type/interface declarations only, no executable logic.
        'packages/shared/src/types.ts',
        'packages/scrapers/src/types.ts',
        // Live network smoke script — never run in CI/tests by design.
        'packages/scrapers/src/smoke.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
