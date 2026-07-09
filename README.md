# Job Portal

Self-hosted service that scrapes local job sources, enriches postings via an
LLM pipeline, and exposes matched jobs through a REST API for n8n to poll.
See [`job-portal-prd.md`](./job-portal-prd.md) for the full product spec.

This repo is currently at **Sprint S0 (Foundations)**: monorepo scaffolding,
config loader, DB schema/migrations, and an API skeleton with health check +
bearer auth. Scrapers, the LLM pipeline, and BullMQ workers land in later
sprints (see PRD §18 for the phased build plan).

## Requirements

- Node.js 24 LTS
- pnpm 9 (`corepack enable` will pick up the pinned version from `package.json`)
- Docker (for Postgres/Redis in local dev, and for the Testcontainers-backed
  DB test suite)

## Repository layout

```
apps/
  api/        Express server — pull API for n8n, admin endpoints, health
    src/middleware/  auth (bearer token)
    src/routes/      health, ping (+ growth: controller/route → service → repository)
    src/openapi.ts   hand-authored OpenAPI 3 spec served at GET /docs
  worker/     BullMQ workers (S0: stub that runs migrations and idles)
packages/
  db/         Drizzle schema, migrations, client factory, advisory-lock runner
  config/     zod-validated config loader (YAML + env)
  scrapers/   Adapter interface + per-source adapters (stub in S0)
  llm/        OpenRouter client + enrichment pipeline (stub in S0)
  shared/     Logger factory, error classes, shared types
config/
  sources.yaml  Source declarations (URL, cron, source_type, enabled)
  app.yaml      LLM/retry/n8n/timezone config
docker/
  Dockerfile         Multi-stage build; same image, different CMD per service
  docker-compose.yml api + worker services (Postgres/Redis are external)
.github/workflows/ci.yml   lint, typecheck, test:coverage, docker build
```

## Setup

```bash
corepack enable
pnpm install
cp .env.example .env   # then fill in DATABASE_URL, REDIS_URL, etc.
```

`config/sources.yaml` and `config/app.yaml` ship with working sample values;
edit them to add/change sources or tune retry/LLM settings.

## Running

```bash
# Apply DB migrations (advisory-lock guarded — safe to run from both
# api and worker on startup; see packages/db/src/migrate.ts)
pnpm --filter @job-portal/db db:migrate

# API (dev, with reload)
pnpm --filter @job-portal/api dev

# Worker (dev, with reload) — S0: stub, runs migrations then idles
pnpm --filter @job-portal/worker dev
```

## Docker

```bash
docker compose -f docker/docker-compose.yml config   # validate
docker compose -f docker/docker-compose.yml up --build
```

Postgres and Redis are **not** started by this compose file — point
`DATABASE_URL` / `REDIS_URL` at your existing instances via `.env`.

## Testing

```bash
pnpm test              # unit + integration tests
pnpm test:coverage      # with v8 coverage (80% line/statement/function gate)
pnpm lint
pnpm typecheck
```

The `packages/db` test suite spins up a real Postgres via Testcontainers and
requires a working Docker daemon; it self-skips (with a console warning) if
Docker isn't reachable, so `pnpm test` stays green in Docker-less
environments.

## Scripts (root)

| Script | Description |
|---|---|
| `pnpm lint` | ESLint across the monorepo |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | Vitest, single run |
| `pnpm test:coverage` | Vitest with v8 coverage, 80% gate |
| `pnpm build` | `tsc` build in every package (dependency-ordered) |

## Judgment calls (S0)

- `jobs` table carries normalized `title`/`company`/`location`/`apply_url`/`posted_at`
  columns (extracted from `raw` at insert time) in addition to `raw` JSONB,
  since the pull API (PRD §12) returns them directly.
- Advisory lock uses two int32 keys (`pg_try_advisory_lock(72617, 1)`) rather
  than a single bigint, to avoid JS bigint/postgres.js param-binding friction.
- `/health` dependency checks are injected into `createApp()` so the API test
  suite can simulate db/redis outages without needing live infra; the real
  checks (`select 1`, Redis `PING`) are wired in `apps/api/src/index.ts`.
- Coverage `include` in `vitest.config.ts` is scoped to implemented S0 source
  (api, config, db, shared) — widen it as scrapers/llm/worker gain real logic
  in later sprints, so the 80% gate stays meaningful rather than vacuous.
