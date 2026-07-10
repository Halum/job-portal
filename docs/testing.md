# Testing & Coverage

## Framework

[Vitest](https://vitest.dev) (`vitest run`), single root config in
[`vitest.config.ts`](../vitest.config.ts). Node environment, no globals —
tests import `describe`/`it`/`expect` explicitly. Test files are
`{apps,packages}/**/*.{test,spec}.ts`.

Commands (root):

- `pnpm -w test` — run the suite once.
- `pnpm -w test:coverage` — run with v8 coverage + threshold enforcement (what CI runs).

## Coverage gate

v8 provider, enforced thresholds (build fails below any of these):

| Metric | Threshold |
| --- | --- |
| Statements | 80% |
| Lines | 80% |
| Functions | 80% |
| Branches | 70% |

CI enforces this: `.github/workflows/ci.yml` runs `pnpm test:coverage` (not
plain `test`), so a drop below the gate fails the `test` job and blocks the
downstream `docker-build` job (PRD §17).

## Test layers

- **Unit tests** — pure logic with dependency injection and stubs. No I/O.
  Examples: `renderTemplate` and the OpenAI-mocked LLM client
  (`packages/llm`), the enrichment handler and error notifier with fake
  `db`/`llm`/`fetch` (`apps/worker`), config loader, Express auth + route
  validation with a stub `db` (`apps/api`).
- **Adapter tests** — scrapers are tested against **saved HTML/JSON fixtures**
  (`packages/scrapers/test/fixtures/`), so parsing is verified deterministically
  without hitting live sites.
- **Integration tests (Testcontainers)** — real Postgres (`postgres:16-alpine`)
  and, for the scrape pipeline, real Redis (`redis:7-alpine`) spun up per suite.
  Cover the DB repositories, the API endpoints end-to-end via supertest, and
  the BullMQ scrape→enqueue flow. These suites `describe.skipIf(!docker)` —
  they skip cleanly when no Docker daemon is reachable, and run in full in CI.
- **Mocked external services** — the OpenAI SDK (OpenRouter) and the n8n error
  webhook (`fetch`) are always stubbed; tests never make network calls.

## Manual smoke scripts (not part of coverage)

`pnpm smoke:arbeitsagentur` / `pnpm smoke:feki` (`packages/scrapers/src/smoke.ts`)
hit the **live** sources to sanity-check adapters by hand. They are never run
in CI or the test suite by design, and are excluded from coverage.

## What's excluded from coverage, and why

Coverage `include` is scoped to `src/**` of every app and package; the
`exclude` list (mirrors `vitest.config.ts`):

- **`**/*.test.ts`, `**/*.spec.ts`** — the tests themselves.
- **`**/*.d.ts`** — ambient type declarations, no runtime code.
- **`**/index.ts`** — barrel re-export files and the app entrypoints
  (`apps/api/src/index.ts`, `apps/worker/src/index.ts`): wiring only —
  config + logger + server/worker bootstrap — with no branching logic worth
  asserting. The testable logic lives in `createApp` / the handler factories,
  which are covered.
- **`packages/db/src/schema/*.ts`** — Drizzle table/enum DDL definitions,
  declarative schema with no executable logic.
- **`packages/db/drizzle/**`** — generated SQL migrations + snapshots.
- **`packages/db/src/run-migrate.ts`** — thin CLI entrypoint that wires
  `runMigrationsWithLock` (which is itself unit tested); not worth mocking
  `process.exit`.
- **`packages/shared/src/types.ts`, `packages/scrapers/src/types.ts`** —
  type/interface declarations only, no executable logic.
- **`packages/scrapers/src/smoke.ts`** — live-network manual script, never run
  in tests by design.
