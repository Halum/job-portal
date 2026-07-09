import { Redis } from 'ioredis';
import { loadConfigOrExit } from '@job-portal/config';
import { createDbClient, runMigrationsWithLock } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
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

const { sql, close: closeDb } = createDbClient(config.env.DATABASE_URL);
const redis = new Redis(config.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

const app = createApp({
  bearerToken: config.env.API_BEARER_TOKEN,
  logger,
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
  await closeDb();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
