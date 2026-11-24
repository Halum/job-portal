import { createAccounts } from '@job-portal/accounts';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
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
createApiServer({ accounts, discovery, matching, pipeline, tracker, logger }).listen(
  config.port,
  config.host,
  () => {
    logger.info({ host: config.host, port: config.port }, 'api ready, MCP at /mcp');
  },
);
