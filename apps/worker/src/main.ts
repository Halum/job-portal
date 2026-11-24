import { createAccounts } from '@job-portal/accounts';
import { createBoardDirectory } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createMatching } from '@job-portal/matching';
import { createDiscovery } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createTracker } from '@job-portal/tracker';
import { createLogger } from '@job-portal/shared';
import { buildSources } from './sources';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db } = createDb(config.databaseUrl);
const user = await createAccounts(db, config.mcpBearerToken).seedUser(config.seedUserEmail);

// Targets decide what the Bundesagentur search asks for; Discovery supplies the Jobs Matching may look at.
// A Job with any application status is skipped by matching (hasApplication, from the Tracker).
// (`discovery` and `tracker` are created below; the callbacks only run during a run, after they exist.)
const matching = createMatching(db, {
  loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
  defaultPrerankTopN: config.prerankTopN,
});

const directory = createBoardDirectory(db);
const { sources, scheduled } = buildSources(config, { matching, directory, userId: user.id });
// Discovery snapshots its Sources, so it is created only now, with every one of them in the list.
const discovery = createDiscovery(db, sources);
const tracker = createTracker(db, discovery);
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
