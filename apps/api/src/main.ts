import { createDiscovery, discoveryMigrations } from '@job-portal/discovery';
import { createPipeline, pipelineMigrations } from '@job-portal/pipeline';
import { accountsMigrations, createAccounts } from '@job-portal/accounts';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'api' });

await runMigrationsWithLock(
  config.databaseUrl,
  [accountsMigrations, discoveryMigrations, pipelineMigrations],
  logger,
);
const { db } = createDb(config.databaseUrl);
const accounts = createAccounts(db, config.mcpBearerToken);
await accounts.seedUser(config.seedUserEmail);

// The API only reads: it has no sources, so it can show runs and jobs but never polls.
const discovery = createDiscovery(db, []);
const pipeline = createPipeline(db, discovery);
createApiServer({ accounts, discovery, pipeline, logger }).listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api ready, MCP at /mcp');
});
