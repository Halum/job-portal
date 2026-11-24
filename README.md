# Job automation

Search and tracking system for job postings. Spec: GitHub issue #3. See `AGENTS.md` for rules and the architecture map, `GLOSSARY.md` for terms.

## Run locally

Needs Node 24, pnpm 9 and Docker.

```bash
pnpm install
docker compose up -d          # throwaway Postgres 16 and Redis 7
cp .env.example .env          # then set MCP_BEARER_TOKEN
pnpm dev:api                  # migrates, seeds one user, serves MCP at http://localhost:3000/mcp
pnpm dev:worker               # polls the configured sources on their interval
docker compose down           # wipes everything
```

The API listens on `127.0.0.1` by default; set `HOST` (for example to the tailnet IP, or `0.0.0.0`) to reach the MCP endpoint over the tailnet.

Call the endpoint with `Authorization: Bearer <MCP_BEARER_TOKEN>`; the `whoami` tool returns the seeded user. Set `BUNDESAGENTUR_QUERY` in `.env` and the worker polls the Bundesagentur job board; `list_jobs`, `get_job` and `get_run_history` show the result.

## Check

```bash
pnpm typecheck && pnpm lint && pnpm test:coverage   # integration tests need Docker
```

The pre-commit hook (husky) is installed per worktree by `pnpm install` (`scripts/prepare-hooks.sh` sets `core.hooksPath` with `git config --worktree`, so other worktrees and checkouts of this repo are not affected). Run `pnpm install` in each new worktree. It runs typecheck, lint and the fast tests, plus gitleaks, osv-scanner and semgrep when those binaries are installed. CI always runs all of them.
