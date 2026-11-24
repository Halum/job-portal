import { accountsMigrations, createAccounts } from '@job-portal/accounts';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import {
  BUNDESAGENTUR,
  createBundesagenturSource,
  createDiscovery,
  discoveryMigrations,
  type Source,
} from '@job-portal/discovery';
import { createPipeline, pipelineMigrations } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { startWorker, type ScheduledSource } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });

await runMigrationsWithLock(
  config.databaseUrl,
  [accountsMigrations, discoveryMigrations, pipelineMigrations],
  logger,
);
const { db } = createDb(config.databaseUrl);
const user = await createAccounts(db, config.mcpBearerToken).seedUser(config.seedUserEmail);

const sources: Source[] = [];
const scheduled: ScheduledSource[] = [];
const { bundesagentur } = config.sources;
if (bundesagentur) {
  sources.push(createBundesagenturSource({ query: bundesagentur.query }));
  scheduled.push({ sourceId: BUNDESAGENTUR, intervalMinutes: bundesagentur.intervalMinutes });
}
const pipeline = createPipeline(db, createDiscovery(db, sources));

const worker = await startWorker({
  redisUrl: config.redisUrl,
  pipeline,
  userId: user.id,
  sources: scheduled,
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(() => process.exit(0));
  });
}
