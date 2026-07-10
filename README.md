# Job Portal

Self-hosted service that scrapes local (Bamberg-area) job sources, enriches each
posting through a two-pass LLM pipeline, and exposes the matched jobs through a
bearer-authenticated REST API that [n8n](https://n8n.io) polls on a schedule.

It is a **personal, long-running service** — boring, self-contained, and meant
to run for years on a home server with an existing Postgres and Redis.

## What it does

1. **Scrape** — a BullMQ cron job fetches each enabled source (Arbeitsagentur
   REST API, feki.de HTML) on its own schedule, normalizes listings, and inserts
   new ones (deduped on `source + external_id`).
2. **Enrich** — every new job is run through two LLM passes on OpenRouter: a
   cheap **filter** pass (`should_notify`?) and, for matches, a richer
   **summary** pass. Prompts are per-source and per-role, editable at runtime.
3. **Serve** — n8n polls `GET /api/jobs` over contiguous time windows and routes
   matched jobs onward (email, Slack, etc. — outside this repo).

Failures at any stage are recorded in an `errors` table and pushed to an n8n
error webhook.

## System design

```
                        config/  (loaded + zod-validated at boot)
              sources.yaml (cron, url, type)      app.yaml (llm, retries, n8n)
                                    │
  ┌─────────────────────────────────┴───────────────────────────────────────┐
  │                                 WORKER                                    │
  │                                                                          │
  │   BullMQ repeatable (cron, Europe/Berlin)                                │
  │        │                                                                 │
  │        ▼                                                                 │
  │   scrape queue ──► scrape worker ──► adapter.fetch(url)                  │
  │                         │             (arbeitsagentur | feki)            │
  │                         ▼                                                │
  │                  insert new jobs (ON CONFLICT source+external_id DO      │
  │                         │          NOTHING) ─► returns new ids           │
  │                         ▼                                                │
  │                  enrichment queue ──► enrichment worker                  │
  │                                            │  two-pass                   │
  │                                            ▼                             │
  │                                     OpenRouter LLM                       │
  │                                     filter ──► summary                   │
  │                                            │                             │
  │      on final failure ─► errors row + POST n8n error webhook            │
  └────────────────────────────────┬─────────────────────────────────────────┘
                                    │  status = matched | filtered_out |
                                    │           enrichment_failed | unenriched
              ┌─────────────────────┴──────────┐         ┌──────────────┐
              │            Postgres             │◄───────►│    Redis     │
              │   jobs · prompts · errors       │  BullMQ │   (queues)   │
              └─────────────────────┬───────────┘         └──────────────┘
                                    │
  ┌─────────────────────────────────┴───────────────────────────────────────┐
  │                                  API                                     │
  │   Pull  : GET /api/jobs (windowed)   GET /api/jobs/:id                   │
  │   Admin : GET/POST /api/prompts   POST /api/admin/reenrich               │
  │           GET /api/sources        GET /api/errors                        │
  │   Public: GET /health             GET /docs  (OpenAPI / Swagger UI)      │
  └─────────────────────────────────┬───────────────────────────────────────┘
                                     │  Authorization: Bearer <token>
                                     ▼
                                 ┌───────┐
                                 │  n8n  │  polls each window, routes matches
                                 └───────┘
```

Both the **api** and **worker** run the same Docker image (different command).
Both attempt DB migrations at startup under a Postgres advisory lock, so parallel
starts never race. Postgres and Redis are **external** — this repo never manages
them.

## Repository layout

```
apps/
  api/         Express server — pull API, admin API, /health, /docs
    src/routes/      jobs, admin, prompts, health, ping
    src/middleware/  bearer auth (constant-time compare)
    src/openapi.ts   hand-authored OpenAPI 3 spec served at GET /docs
  worker/      BullMQ workers — scrape + two-pass enrichment, error notifier
packages/
  db/          Drizzle schema, migrations, repositories, advisory-lock runner
  config/      zod-validated config loader (YAML + env)
  scrapers/    Adapter interface + Arbeitsagentur / feki adapters
  llm/         OpenRouter client + prompt template rendering
  shared/      Logger, error classes, shared types, BullMQ queue helpers
config/
  sources.yaml   Source declarations (name, source_type, url, cron, enabled)
  app.yaml       LLM models, retry/backoff, rate limit, n8n webhook, timezone
docker/
  Dockerfile         Multi-stage build; one image, different CMD per service
  docker-compose.yml api + worker services (Postgres/Redis are external)
docs/
  testing.md         Test layers + coverage strategy
.github/workflows/ci.yml   lint · typecheck · test:coverage · docker build
```

## Requirements

- **Node.js 24 LTS**
- **pnpm 9** (`corepack enable` picks up the pinned version)
- **Docker** — to run Postgres/Redis locally and for the Testcontainers-backed
  integration suite
- **An OpenRouter API key** for enrichment (optional to boot — without it,
  scraping still runs and jobs queue up as `unenriched`; drain them later with
  `POST /api/admin/reenrich` once the key is set)

## Configuration

Two layers (see PRD §7):

- **`config/*.yaml`** — non-secret structure. `sources.yaml` declares each source
  (URL, 5-field cron in `Europe/Berlin`, `enabled`); `app.yaml` holds LLM models,
  retry/backoff, rate limits, the n8n error webhook URL, and timezone. Both ship
  with working sample values.
- **Env vars** (`.env` locally, host env / secrets in prod) — connection strings
  and secrets:

  | Var | Purpose |
  |---|---|
  | `DATABASE_URL` | Postgres connection string |
  | `REDIS_URL` | Redis connection string |
  | `OPENROUTER_API_KEY` | LLM enrichment (may be empty to defer enrichment) |
  | `API_BEARER_TOKEN` | Static token required on every route except `/health` |
  | `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
  | `NODE_ENV` | `development` \| `test` \| `production` |

The config loader validates everything with zod at process start and exits with a
clear message if anything is missing or malformed.

## Running locally

```bash
corepack enable
pnpm install
cp .env.example .env      # fill in DATABASE_URL, REDIS_URL, API_BEARER_TOKEN, OPENROUTER_API_KEY
```

Bring up Postgres and Redis however you like — e.g. one-off containers:

```bash
docker run -d --name jp-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
docker run -d --name jp-redis -p 6379:6379 redis:7-alpine
# then set DATABASE_URL / REDIS_URL in .env to match
```

Migrations run automatically when the api or worker boots, or apply them by hand:

```bash
pnpm --filter @job-portal/db db:migrate
```

Start each process (separate terminals, hot reload):

```bash
pnpm --filter @job-portal/api dev       # http://localhost:3000
pnpm --filter @job-portal/worker dev    # scrape + enrichment workers
```

Sanity checks:

```bash
curl localhost:3000/health
open  http://localhost:3000/docs                         # Swagger UI
curl -H "Authorization: Bearer $API_BEARER_TOKEN" localhost:3000/api/sources
```

Before enrichment can match anything, seed the prompts for each source:

```bash
curl -X POST localhost:3000/api/prompts \
  -H "Authorization: Bearer $API_BEARER_TOKEN" -H 'content-type: application/json' \
  -d '{"source":"feki","role":"filter","template":"Job: {{title}} at {{company}} in {{location}}. Reply JSON {should_notify:boolean, reason:string}."}'
```

## Running in production

Postgres and Redis are assumed to already exist on the host. The api and worker
share one image; migrations self-apply at startup under an advisory lock.

**Option A — build and run with Compose** (on the host):

```bash
cp .env.example .env      # fill in real DATABASE_URL / REDIS_URL / secrets
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
```

Compose reads env from the file; `api` is published on `:3000`, both restart
`unless-stopped`.

**Option B — pull the CI-built image.** On a push to `main`, CI builds and pushes
`ghcr.io/<owner>/<repo>:latest` (and `:<sha>`). Point the compose `image:` at that
tag (drop the `build:` block) and `docker compose ... up -d`.

Operational notes:

- **Health**: `GET /health` returns `200` only when both Postgres and Redis are
  reachable (`503` otherwise) — wire it to your uptime check.
- **Logs**: pino JSON to stdout; captured by Docker. Request IDs on the API, job
  IDs on the worker.
- **Backpressure / rate limits**: enrichment concurrency and the OpenRouter rate
  limit are set in `app.yaml` (`llm.global_concurrency`, `llm.rate_limit`).
- **Recovering a backlog**: if OpenRouter was down, re-queue stuck jobs with
  `POST /api/admin/reenrich` (filter by `status`, `source`, or a time window).

## API surface

All routes require `Authorization: Bearer <API_BEARER_TOKEN>` except `/health`
and `/docs`. Full schemas live in the OpenAPI spec at **`GET /docs`**.

| Method & path | Purpose |
|---|---|
| `GET /api/jobs` | Matched jobs in a time window (`from`/`to`/`status`/`source`/`limit`/`offset`) — n8n's poll endpoint |
| `GET /api/jobs/:id` | One job, full detail incl. raw payload |
| `GET /api/prompts` | Get the prompt for a `source` + `role` |
| `POST /api/prompts` | Upsert the prompt for a `source` + `role` (destructive, no versioning) |
| `POST /api/admin/reenrich` | Re-queue enrichment for a filter set |
| `GET /api/sources` | Configured sources (from `sources.yaml`) |
| `GET /api/errors` | Audit view over the `errors` table |
| `GET /health` | Liveness + dependency health (no auth) |

## Testing

```bash
pnpm test            # Vitest, single run
pnpm test:coverage   # v8 coverage, enforced gate (80% stmts/lines/funcs, 70% branches)
pnpm lint
pnpm typecheck
pnpm build
```

Integration suites spin up real Postgres + Redis via Testcontainers and
self-skip (with a warning) when no Docker daemon is reachable, so `pnpm test`
stays green in Docker-less environments. Adapters are tested against saved
fixtures; the LLM client and error webhook are mocked. See
[`docs/testing.md`](./docs/testing.md) for the full strategy and coverage
exclusions.

Manual live smoke checks (never run in CI):

```bash
pnpm smoke:arbeitsagentur
pnpm smoke:feki
```
