import { Queue, Worker } from 'bullmq';
import { loadConfigOrExit } from '@job-portal/config';
import { createDbClient, markEnrichmentFailed, runMigrationsWithLock } from '@job-portal/db';
import { createLlmClient } from '@job-portal/llm';
import {
  createLogger,
  createRedisConnection,
  ENRICHMENT_QUEUE,
  SCRAPE_QUEUE,
} from '@job-portal/shared';
import { createScrapeHandler, registerScrapeJobs, type ScrapePayload } from './scrape.js';
import { createEnrichmentHandler, type EnrichmentPayload } from './enrich.js';
import { createErrorNotifier } from './notify.js';

const config = loadConfigOrExit();
const logger = createLogger({ level: config.env.LOG_LEVEL, name: 'worker' });

// Both api and worker run migrations under an advisory lock on startup (PRD §15).
await runMigrationsWithLock(config.env.DATABASE_URL, { logger });

const { db, close: closeDb } = createDbClient(config.env.DATABASE_URL);
const connection = createRedisConnection(config.env.REDIS_URL);

const scrapeQueue = new Queue(SCRAPE_QUEUE, { connection });
// Retry policy attached here so it applies to every enrichment job, however
// enqueued (scrape today, the S3 reenrich endpoint later).
const enrichmentQueue = new Queue(ENRICHMENT_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: config.app.retries.enrichment.attempts,
    backoff: { type: 'exponential', delay: config.app.retries.enrichment.backoff_ms },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

const handleScrape = createScrapeHandler({ db, enrichmentQueue, logger });
const llm = createLlmClient({ apiKey: config.env.OPENROUTER_API_KEY });
const handleEnrichment = createEnrichmentHandler({ db, llm, config, logger });
const notify = createErrorNotifier({ db, config, logger });

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
  logger.error({ jobId: job?.id, source: job?.data?.sourceName, err }, 'scrape job failed');
  if (job && job.attemptsMade >= config.app.retries.scrape.attempts) {
    void notify({
      event: 'scraper.failed',
      source: job.data.sourceName,
      stage: 'scrape',
      attempts: job.attemptsMade,
      error: err.message,
    });
  }
});

// Enrichment worker: concurrency + Redis-backed rate limiter per PRD §11
// (protects the OpenRouter budget/rate limits shared across all sources).
const enrichmentWorker = new Worker<EnrichmentPayload>(
  ENRICHMENT_QUEUE,
  async (job) => handleEnrichment(job.data),
  {
    connection,
    concurrency: config.app.llm.global_concurrency,
    limiter: {
      max: config.app.llm.rate_limit.max_per_window,
      duration: config.app.llm.rate_limit.window_ms,
    },
  },
);

enrichmentWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'enrichment job failed');
  if (job && job.attemptsMade >= config.app.retries.enrichment.attempts) {
    markEnrichmentFailed(db, job.data.jobId).catch((markErr: unknown) => {
      logger.error({ jobId: job.id, err: markErr }, 'failed to mark enrichment_failed');
    });
    void notify({
      event: 'enrichment.failed',
      source: null,
      jobId: job.data.jobId,
      stage: 'enrichment',
      attempts: job.attemptsMade,
      error: err.message,
    });
  }
});

await registerScrapeJobs(scrapeQueue, config.sources, config.app.retries.scrape);
logger.info(
  { enabledSources: config.sources.filter((s) => s.enabled).length },
  'scrape queue registered, worker running',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await scrapeWorker.close();
  await enrichmentWorker.close();
  await scrapeQueue.close();
  await enrichmentQueue.close();
  connection.disconnect();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
