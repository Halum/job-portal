import { loadConfigOrExit } from '@job-portal/config';
import { runMigrationsWithLock } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';

/**
 * Worker entrypoint. In S0 (Foundations) this is intentionally a stub: it
 * loads config, runs migrations (advisory-lock guarded, racing safely
 * against the api container's own migration attempt), and idles. BullMQ
 * queue registration, scrapers, and the enrichment pipeline land in later
 * sprints (PRD §18 phases 6-7).
 */

const config = loadConfigOrExit();
const logger = createLogger({ level: config.env.LOG_LEVEL, name: 'worker' });

await runMigrationsWithLock(config.env.DATABASE_URL, { logger });

logger.info(
  { sourceCount: config.sources.length },
  'worker started (no queues registered yet — S0 stub)',
);

const heartbeat = setInterval(() => {
  logger.debug('worker heartbeat');
}, 60_000);
heartbeat.unref();

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  clearInterval(heartbeat);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
