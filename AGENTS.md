# Job automation

Search and tracking system for job postings: sources are polled on a schedule, postings are deduplicated and scored against the user's Targets, and everything is driven through an MCP endpoint. Spec: GitHub issue #3. This repo is public: no personal data, no real search criteria, no secrets.

## Branches

`main-automation` (orphan, shares no history with `main`) and `develop-automation`. Feature branches come from `develop-automation` as `feature/*`. The old Job Portal on `main`/`develop` is never touched. No deploy workflow exists here.

## Commands

- `pnpm install`, then `docker compose up -d` and `cp .env.example .env`
- `pnpm dev:api` (MCP at http://localhost:3000/mcp), `pnpm dev:worker` (both load `.env` through `tsx --env-file-if-exists=.env`; without it `loadConfig` fails with ConfigError, because it reads only `process.env`)
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm test:fast` (unit only), `pnpm test` (adds Testcontainers integration, needs Docker), `pnpm test:coverage` (CI gate)
- `pnpm db:generate` after changing a module schema

## Hard rules

- TypeScript strict, no `any`. ESLint strict. Never use the em dash character.
- Each domain module is a package with its own Postgres schema and its own Drizzle migrations. A module never queries another module's schema; it calls that module's interface.
- Secrets and the user's real details come from env only. Never commit `.env`.
- Numeric settings: null means unset, never a falsy check (`0` is a valid value).
- Tests drive public interfaces. Integration tests use real Postgres and Redis through Testcontainers; nothing hits the network. Name them `*.integration.test.ts`.
- Coverage gate: statements, lines, functions 80%, branches 70%.
- Hooks are per worktree: `pnpm install` runs `scripts/prepare-hooks.sh`, which sets `core.hooksPath` with `git config --worktree` (never the shared `.git/config`). Run it in every new worktree.
- Pre-commit runs typecheck, lint, fast tests, and gitleaks, osv-scanner, semgrep when installed. CI runs all of them.
- Agent decisions are in `docs/adr/agent/`.
- Terms in `GLOSSARY.md` name things in code, database, tests and issues.

## Architecture map

- `packages/shared`: logger.
- `packages/config`: zod-validated env config (`loadConfig`).
- `packages/db`: Drizzle on postgres.js client and `runMigrationsWithLock` (advisory lock, one tracking table per module in schema `drizzle`).
- `packages/accounts`: schema `accounts`, users table, seed, constant-time bearer token check (`MCP_BEARER_TOKEN`).
- `packages/discovery`: schema `discovery`: Postings (unique per user, source, source posting id) and Jobs (one or more Postings each, merged by unique per-user company key or URL key, `src/keys.ts`; ADR 0006). Source interface, the Bundesagentur and bambase sources (`src/sources/`, recorded fixtures in `src/sources/fixtures/`), `poll`, `listJobs`, `getJob`, `addJob`, `splitJob`, `listMergeConflicts`.
- `packages/pipeline`: schema `pipeline`: Runs (counts, status running / completed / completed_with_errors / failed). `execute` polls one source through Discovery; the database allows one running run per user and source; a run still running after `staleAfterMs` (default one hour) counts as lost: the next `execute` for that source and the sweep on worker start (`failStaleRuns`) fail it, and never touch a fresh run, so several workers can share a database.
- `packages/migrations`: `allMigrations`, the one ordered list of every module's migrations (api, worker and tests apply it).
- `apps/api`: stateless Streamable HTTP MCP endpoint at `/mcp`, bearer auth, tools `whoami`, `list_jobs`, `get_job`, `add_job`, `split_job`, `get_run_history` (`src/tools.ts`). `get_run_history` includes `errorCount`. Package entry exports `createApiServer`, so the worker's end-to-end test depends on `@job-portal/api` explicitly. Migrates and seeds on start; read only, it never polls.
- `apps/worker`: migrates, seeds, marks stale runs failed, then schedules one BullMQ Job Scheduler per configured source (scheduler id = source id) and runs each tick through the Pipeline. `src/tracer.integration.test.ts` is the end-to-end test through MCP.

Packages export TypeScript source directly (no build step); processes run with `tsx`.
