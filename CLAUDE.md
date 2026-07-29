# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All root scripts run against the whole pnpm workspace. Node 24 + pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm -w lint            # eslint .            (lint:fix to autofix)
pnpm -w typecheck       # tsc -b (project references — build graph, not per-package)
pnpm -w test            # vitest run (single root config, all apps+packages)
pnpm -w test:coverage   # vitest + v8 coverage + threshold gate — what CI runs
pnpm -w format          # prettier --write .  (format:check to verify)
pnpm -w build           # tsc -b
```

Run one package's tests / a single test:

```bash
pnpm vitest run packages/llm                          # one package
pnpm vitest run apps/worker/test/enrich.test.ts       # one file
pnpm vitest run -t 'filtered out'                     # by test name
```

DB / scrapers:

```bash
pnpm --filter @job-portal/db db:generate   # drizzle-kit: emit SQL after schema change
pnpm --filter @job-portal/db db:migrate    # apply migrations by hand (also auto-run at api/worker boot)
pnpm --filter @job-portal/api dev          # tsx watch, :3000, loads .env
pnpm --filter @job-portal/worker dev       # scrape + enrichment workers
pnpm -w smoke:arbeitsagentur               # hit LIVE source to sanity-check adapter (never in CI)
pnpm -w smoke:feki
```

Integration tests (`*.integration.test.ts`, DB/repo/API suites) use Testcontainers and `describe.skipIf(!docker)` — they skip silently without a Docker daemon and run fully in CI. Docker must be up to exercise them locally.

## Architecture

Two processes (`apps/api`, `apps/worker`) share **one Docker image** (different CMD) and a set of `packages/*`. Postgres + Redis are **external** — this repo never manages them. See `README.md` for the full system diagram and `docs/testing.md` for the test strategy.

Data flow: `worker` runs a BullMQ repeatable cron per source → **scrape queue** → adapter fetches + normalizes → insert new jobs (`ON CONFLICT (source, external_id) DO NOTHING`) → **enrichment queue** → two-pass LLM → job status set. `api` serves those jobs; n8n (`n8n/*.json`) polls `GET /api/jobs` + `GET /api/errors` over time windows and fans out to Telegram.

Job `status`: `unenriched` → `matched` | `filtered_out` | `enrichment_failed`.

### Non-obvious things that will bite you

- **The filter LLM pass only EXTRACTS, it does not decide.** It returns `{german_phrase, german_requirement, reason}`; the match verdict is computed in code via `shouldNotify()` (`packages/llm`), called from `apps/worker/src/enrich.ts`. Never move the notify decision into the prompt — deriving it in code is what makes the German-language filter reliable. Filter templates must be written to extract, not to answer yes/no.

- **`jobs.source` ≠ `source_type`.** `source` holds the `sources.yaml` `name` (e.g. `arbeitsagentur-bamberg`); multiple named sources can share one `source_type`. **Prompts and adapters are keyed by `source_type`**, so resolve it through the loaded source config (`config.sources.find(s => s.name === job.source).source_type`) — never assume `source_type === job.source`.

- **Terminal vs retryable failures in enrichment** (`enrich.ts`): a missing prompt / unknown source is terminal — mark `enrichment_failed`, error-notify, and `return` (do NOT throw, BullMQ would pointlessly retry an unfixable condition). LLM/network failures **throw** so BullMQ retries per `retries.enrichment`. Preserve this split when editing the handler.

- **Migrations self-apply at boot under a Postgres advisory lock** (`packages/db/src/migrate.ts`), so parallel api+worker starts never race. A waiter re-runs `migrate` (idempotent, `__drizzle_migrations`-guarded) rather than assuming the previous holder finished — guards against a crash mid-migration.

- **Config is two layers, both loaded + zod-validated at boot** (`packages/config`): `config/sources.yaml` (per-source `name`, `source_type`, `url`, 5-field `Europe/Berlin` cron, `enabled`) and `config/app.yaml` (LLM models, retries/backoff, rate limit, n8n webhook, timezone). Secrets come from env only (`DATABASE_URL`, `REDIS_URL`, `OPENROUTER_API_KEY`, `API_BEARER_TOKEN`). Boot fails loudly on any missing/malformed value.

- **Queue names live in `packages/shared/src/queues.ts`** — single source of truth so `api` (the reenrich producer) and `worker` (consumer) never depend on each other. BullMQ Workers need `maxRetriesPerRequest: null` on the Redis connection; use `createRedisConnection()`.

- **Every route except `/health` requires `Authorization: Bearer <API_BEARER_TOKEN>`** (constant-time compare, `apps/api/src/middleware/auth.ts`).

### Adding things

- **New API endpoint** → also add it to the hand-authored OpenAPI spec `apps/api/src/openapi.ts` (served at `/docs`) in the same change. (Project rule: every endpoint gets OpenAPI docs in the same sprint.)
- **New scrape source** → add a `sources.yaml` entry; add an adapter in `packages/scrapers` implementing the adapter interface (`types.ts`) and register it in `getAdapter`; test against a saved fixture in `test/fixtures/`.
- **Schema change** → edit `packages/db/src/schema/*.ts`, then `db:generate` to emit the SQL migration; commit both.

## Keeping this file current

After a change that introduces a new non-obvious operational rule, a new gotcha, or changes which README/config/topology fact is authoritative — add or update one line here. Routine source edits, new sources/adapters, or anything already derivable from reading the code don't need an entry. If unsure whether something belongs, ask: "would omitting this cause a future agent to make a mistake?" If not, leave it out.

## Coverage gate

CI runs `test:coverage` with enforced thresholds (lines/statements/functions 80%, branches 70%) — a drop below fails the build. Barrel `index.ts` files, schema DDL, generated migrations, `types.ts`, and the live `smoke.ts` are excluded (see `vitest.config.ts`). External services (OpenRouter/OpenAI SDK, n8n webhook `fetch`) are always stubbed; tests make no network calls.
