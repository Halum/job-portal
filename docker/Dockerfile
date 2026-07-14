# syntax=docker/dockerfile:1

# ---- base -------------------------------------------------------------
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- build ------------------------------------------------------------
# Full install (dev + prod), build, then `pnpm deploy` each app into a
# self-contained folder (own node_modules + built dist of its workspace
# deps). Adding a new package needs no Dockerfile change — deploy follows
# the dependency graph.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter=@job-portal/api --prod /app/deploy-api
RUN pnpm deploy --filter=@job-portal/worker --prod /app/deploy-worker

# ---- runtime ----------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/deploy-api ./apps/api
COPY --from=build /app/deploy-worker ./apps/worker
COPY config ./config

USER app
EXPOSE 3000

# CMD is overridden per service in docker-compose.yml (api vs worker).
CMD ["node", "apps/api/dist/index.js"]
