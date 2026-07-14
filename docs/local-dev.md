# Running locally

Runs the api and worker directly on your machine with hot reload
(`tsx watch`), against a Postgres + Redis you already have (e.g. a homeserver
instance) — no Docker required for the app itself.

## 1. Install

```bash
corepack enable
pnpm install
```

## 2. Database + user (if you don't already have one)

In DBeaver (or any SQL client) connected as a Postgres admin user, run:

```sql
CREATE USER job_portal_app WITH PASSWORD 'pick-a-strong-password-here';
CREATE DATABASE job_portal OWNER job_portal_app;
```

Switch the SQL editor's active database to `job_portal`, then:

```sql
GRANT ALL ON SCHEMA public TO job_portal_app;
```

The app's Drizzle migrations create the `jobs` / `prompts` / `errors` tables
automatically on first boot — nothing else to run by hand.

## 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in:

```
DATABASE_URL=postgres://job_portal_app:<password>@<host>:5432/job_portal
REDIS_URL=redis://<host>:6379
OPENROUTER_API_KEY=<your key, or leave blank to defer enrichment>
API_BEARER_TOKEN=<any random string>
LOG_LEVEL=debug
NODE_ENV=development
```

If Redis is a shared instance (not dedicated to this app), pick an unused
logical DB index to avoid BullMQ key collisions: `redis://<host>:6379/3`.

## 4. Start the api (terminal 1)

```bash
pnpm --filter @job-portal/api dev
```

Migrations apply automatically under an advisory lock. Look for
`"msg":"api listening"` in the log.

## 5. Start the worker (terminal 2)

```bash
pnpm --filter @job-portal/worker dev
```

## 6. Verify

```bash
curl localhost:3000/health
```

Expect `{"status":"ok","db":"ok","redis":"ok"}`. If `db` or `redis` says
`fail`, the connection string in `.env` is wrong or the host isn't reachable
from your machine.

Swagger UI: <http://localhost:3000/docs>

## 7. Seed prompts

Enrichment needs a `filter` and `summary` prompt per source before it can
match anything:

```bash
curl -X POST localhost:3000/api/prompts \
  -H "Authorization: Bearer $API_BEARER_TOKEN" -H 'content-type: application/json' \
  -d '{"source":"feki","role":"filter","template":"Job: {{title}} at {{company}} in {{location}}. Reply JSON {should_notify:boolean, reason:string}."}'
```

Repeat for `"role":"summary"`, and for each source enabled in
`config/sources.yaml`.

## 8. Trigger a scrape

Sources run on the cron schedule set in `config/sources.yaml`. To see one run
immediately, temporarily set its `cron` to `* * * * *` (every minute), restart
the worker, watch the log, then set it back.

## 9. Check results

```bash
curl -H "Authorization: Bearer $API_BEARER_TOKEN" "localhost:3000/api/jobs?status=matched"
curl -H "Authorization: Bearer $API_BEARER_TOKEN" "localhost:3000/api/errors"
```

## Why `--env-file` and `cd ../..`

`pnpm --filter <pkg> dev` runs the script with its cwd set to that package's
directory (e.g. `apps/api/`), not the repo root. The config loader reads
`.env` and `config/*.yaml` as paths relative to cwd — so both `dev` scripts
`cd` to the repo root first and pass `--env-file=.env` (Node's native env-file
loading) before starting `tsx watch`. This matches how the Docker image runs
in production (`WORKDIR /app`, config copied to `/app/config`).
