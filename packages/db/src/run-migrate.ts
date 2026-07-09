import { createLogger } from '@job-portal/shared';
import { runMigrationsWithLock } from './migrate.js';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', name: 'db-migrate' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL is not set');
  process.exit(1);
}

try {
  await runMigrationsWithLock(databaseUrl, { logger });
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'migration run failed');
  process.exit(1);
}
