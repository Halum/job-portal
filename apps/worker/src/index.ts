import { Queue, Worker } from 'bullmq';
import { loadConfigOrExit } from '@job-portal/config';
import { createDbClient, runMigrationsWithLock } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
import { ENRICHMENT_QUEUE, SCRAPE_QUEUE, createRedisConnection } from './queues.js';
import { createScrapeHandler, registerScrapeJobs, type ScrapePayload } from './scrape.js';

const config = loadConfigOrExit();
const logger = createLogger({ level: config.env.LOG_LEVEL, name: 'worker' });

// Both api and worker run migrations under an advisory lock on startup (PRD §15).
await runMigrationsWithLock(config.env.DATABASE_URL, { logger });

const { db, close: closeDb } = createDbClient(config.env.DATABASE_URL);
const connection = createRedisConnection(config.env.REDIS_URL);

const scrapeQueue = new Queue(SCRAPE_QUEUE, { connection });
const enrichmentQueue = new Queue(ENRICHMENT_QUEUE, { connection });

const handleScrape = createScrapeHandler({ db, enrichmentQueue, logger });

// Single scrape Worker, concurrency 1: serializes all scrape jobs, which
// satisfies "same source must not overlap itself" (PRD §10). Cross-source
// parallelism is sacrificed — fine for 2 low-volume cron sources. Upgrade to
// per-source queues if source count/frequency grows.
const scrapeWorker = new Worker<ScrapePayload>(
  SCRAPE_QUEUE,
  async (job) => handleScrape(job.data),
  { connection, concurrency: 1 },
);

scrapeWorker.on('failed', (job, err) => {
  // S1b: log only. S3 wires the errors-table write + n8n error webhook here.
  logger.error({ jobId: job?.id, source: job?.data?.sourceName, err }, 'scrape job failed');
});

await registerScrapeJobs(scrapeQueue, config.sources, config.app.retries.scrape);
logger.info(
  { enabledSources: config.sources.filter((s) => s.enabled).length },
  'scrape queue registered, worker running',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await scrapeWorker.close();
  await scrapeQueue.close();
  await enrichmentQueue.close();
  connection.disconnect();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
