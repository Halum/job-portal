import { createAccounts } from '@job-portal/accounts';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createMatching } from '@job-portal/matching';
import {
  BAMBASE,
  BUNDESAGENTUR,
  bundesagenturQuery,
  createBambaseSource,
  createBundesagenturSource,
  createDiscovery,
  type Source,
} from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { startWorker, type ScheduledSource } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db } = createDb(config.databaseUrl);
const user = await createAccounts(db, config.mcpBearerToken).seedUser(config.seedUserEmail);

// Targets decide what the Bundesagentur search asks for; Discovery supplies the Jobs Matching may look at.
// ponytail: the Tracker's application-status exclusion (hasApplication) is wired when it exists.
// (`discovery` is created below; the callback only runs during a run, after it exists.)
const matching = createMatching(db, {
  loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
  defaultPrerankTopN: config.prerankTopN,
});

const sources: Source[] = [];
const scheduled: ScheduledSource[] = [];
const { bundesagentur, bambase } = config.sources;
if (bundesagentur) {
  sources.push(
    createBundesagenturSource({
      queries: async () => (await matching.searchQueries(user.id)).map(bundesagenturQuery),
    }),
  );
  scheduled.push({ sourceId: BUNDESAGENTUR, intervalMinutes: bundesagentur.intervalMinutes });
}
if (bambase) {
  sources.push(createBambaseSource());
  scheduled.push({ sourceId: BAMBASE, intervalMinutes: bambase.intervalMinutes });
}
const discovery = createDiscovery(db, sources);
const pipeline = createPipeline(db, discovery, { matching });

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
