import { Redis } from 'ioredis';
import { createAccounts } from '@job-portal/accounts';
import { createBoardDirectory, createWatchlist } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createDiscovery, createRateLimitedFetch, createRedisSlots } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createTracker } from '@job-portal/tracker';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'api' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db } = createDb(config.databaseUrl);
const accounts = createAccounts(db, config.mcpBearerToken);
await accounts.seedUser(config.seedUserEmail);

// The API only reads: it has no sources, so it can show runs and jobs but never polls.
const discovery = createDiscovery(db, [], logger);
const pipeline = createPipeline(db, discovery);
// add_board's verification fetch shares the per-host rate limit with the workers through Redis.
const boards = {
  directory: createBoardDirectory(db),
  watchlist: createWatchlist(db),
  fetch: createRateLimitedFetch(config.boardRequestsPerSecond, fetch, {
    slots: createRedisSlots(new Redis(config.redisUrl)),
  }),
};
createApiServer({
  accounts,
  discovery,
  pipeline,
  tracker: createTracker(db, discovery),
  boards,
  logger,
}).listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api ready, MCP at /mcp');
});
