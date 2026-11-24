# Job automation

Search and tracking system for job postings. Spec: GitHub issue #3. See `AGENTS.md` for rules and the architecture map, `GLOSSARY.md` for terms.

## Run locally

Needs Node 24, pnpm 9 and Docker.

```bash
pnpm install
docker compose up -d          # throwaway Postgres 16 and Redis 7
cp .env.example .env          # then set MCP_BEARER_TOKEN
set -a; . ./.env; set +a      # export the variables to your shell
pnpm dev:api                  # migrates, seeds one user, serves MCP at http://localhost:3000/mcp
pnpm dev:worker               # connects to Redis and logs ready
docker compose down           # wipes everything
```

Call the endpoint with `Authorization: Bearer <MCP_BEARER_TOKEN>`; the `whoami` tool returns the seeded user.

## Check

```bash
pnpm typecheck && pnpm lint && pnpm test:coverage   # integration tests need Docker
```

The pre-commit hook (husky, installed by `pnpm install`) runs typecheck, lint and the fast tests, plus gitleaks, osv-scanner and semgrep when those binaries are installed. CI always runs all of them.
