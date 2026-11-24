import { accountsMigrations, createAccounts } from '@job-portal/accounts';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'api' });

await runMigrationsWithLock(config.databaseUrl, [accountsMigrations], logger);
const { db } = createDb(config.databaseUrl);
const accounts = createAccounts(db, config.mcpBearerToken);
await accounts.seedUser(config.seedUserEmail);

createApiServer(accounts, logger).listen(config.port, () => {
  logger.info({ port: config.port }, 'api ready, MCP at /mcp');
});
