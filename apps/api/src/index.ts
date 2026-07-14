import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadConfigOrExit } from '@job-portal/config';
import { createDbClient, runMigrationsWithLock } from '@job-portal/db';
import { createLogger, createRedisConnection, ENRICHMENT_QUEUE } from '@job-portal/shared';
import { createApp } from './app.js';

const config = loadConfigOrExit();
const logger = createLogger({ level: config.env.LOG_LEVEL, name: 'api' });

// Both api and worker attempt migrations at startup under a Postgres advisory
// lock (PRD §15); only one runs them, the other waits. Do this before we
// start serving so we never accept traffic against a missing/half-applied
// schema.
try {
  await runMigrationsWithLock(config.env.DATABASE_URL, { logger });
} catch (error) {
  logger.error({ err: error }, 'migration run failed on api startup');
  process.exit(1);
}

const { db, sql, close: closeDb } = createDbClient(config.env.DATABASE_URL);
const redis = new Redis(config.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

// Enrichment queue producer for /api/admin/reenrich. Same default retry policy
// as the worker (PRD §11) so reenriched jobs inherit identical backoff.
const enrichmentConnection = createRedisConnection(config.env.REDIS_URL);
const enrichmentQueue = new Queue(ENRICHMENT_QUEUE, {
  connection: enrichmentConnection,
  defaultJobOptions: {
    attempts: config.app.retries.enrichment.attempts,
    backoff: { type: 'exponential', delay: config.app.retries.enrichment.backoff_ms },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

const app = createApp({
  bearerToken: config.env.API_BEARER_TOKEN,
  logger,
  db,
  enrichmentQueue,
  sources: config.sources,
  health: {
    checkDb: async () => {
      await sql`select 1`;
      return true;
    },
    checkRedis: async () => {
      const pong = await redis.ping();
      return pong === 'PONG';
    },
  },
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  logger.info({ port }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  await enrichmentQueue.close();
  enrichmentConnection.disconnect();
  await closeDb();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
