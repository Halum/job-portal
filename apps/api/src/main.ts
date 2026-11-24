import { createAccounts } from '@job-portal/accounts';
import { createWatchlist } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { connectRateLimiter, createDiscovery, createRedisLimit } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createTracker } from '@job-portal/tracker';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'api' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db, close: closeDb } = createDb(config.databaseUrl);
const accounts = createAccounts(db, config.mcpBearerToken);
await accounts.seedUser(config.seedUserEmail);

// The API only reads: it has no sources, so it can show runs and jobs but never polls.
const discovery = createDiscovery(db, [], logger);
const tracker = createTracker(db, discovery);
const matching = createMatching(db, {
  loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
  defaultPrerankTopN: config.prerankTopN,
});
const pipeline = createPipeline(db, discovery);
// add_board's verification fetch shares the per-host rate limit with the workers through Redis.
const limiter = connectRateLimiter({
  redisUrl: config.redisUrl,
  requestsPerSecond: config.boardRequestsPerSecond,
  onError: (err) => {
    logger.error({ err }, 'rate limit redis error');
  },
});
// ponytail: 10 add_board attempts per user per hour, fixed in code; make it config if it ever needs tuning
const allowAddBoard = createRedisLimit(limiter.redis, {
  max: 10,
  windowMs: 3_600_000,
  prefix: 'add_board',
});
const server = createApiServer({
  accounts,
  discovery,
  matching,
  pipeline,
  tracker,
  boards: { watchlist: createWatchlist(db), fetch: limiter.fetch, allowAddBoard },
  logger,
}).listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api ready, MCP at /mcp');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      limiter.close();
      void closeDb().then(() => process.exit(0));
    });
    server.closeAllConnections();
  });
}
