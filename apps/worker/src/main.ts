import { Redis } from 'ioredis';
import { createAccounts } from '@job-portal/accounts';
import { createWatchlist } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import {
  BAMBASE,
  BUNDESAGENTUR,
  ATS_IDS,
  createAtsSource,
  createBambaseSource,
  createBundesagenturSource,
  createDiscovery,
  createRateLimitedFetch,
  createRedisSlots,
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

const sources: Source[] = [];
const scheduled: ScheduledSource[] = [];
const { bundesagentur, bambase } = config.sources;
if (bundesagentur) {
  sources.push(createBundesagenturSource({ query: bundesagentur.query }));
  scheduled.push({ sourceId: BUNDESAGENTUR, intervalMinutes: bundesagentur.intervalMinutes });
}
if (bambase) {
  sources.push(createBambaseSource());
  scheduled.push({ sourceId: BAMBASE, intervalMinutes: bambase.intervalMinutes });
}
// Company boards: only marked boards of the Board directory (narrowed by the user's Watchlist) are fetched,
// at a bounded rate per ATS host that every worker and the API share through Redis.
const watchlist = createWatchlist(db);
const limiterRedis = new Redis(config.redisUrl);
const limitedFetch = createRateLimitedFetch(config.boardRequestsPerSecond, fetch, {
  slots: createRedisSlots(limiterRedis),
});
for (const ats of ATS_IDS) {
  const source = config.sources[ats];
  if (!source) continue;
  sources.push(
    createAtsSource(ats, {
      listBoards: () => watchlist.listBoards(user.id, ats),
      fetch: limitedFetch,
    }),
  );
  scheduled.push({ sourceId: ats, intervalMinutes: source.intervalMinutes });
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
    void worker.close().then(() => {
      limiterRedis.disconnect();
      process.exit(0);
    });
  });
}
