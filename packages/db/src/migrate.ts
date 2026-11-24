import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Logger } from '@job-portal/shared';

/** One module's migrations: its own Drizzle folder, tracked in its own table. */
export interface ModuleMigrations {
  /** Module name, e.g. "accounts". Names the tracking table `<name>_migrations`. */
  name: string;
  folder: string;
}

// Arbitrary constant key pair for the migration advisory lock.
const LOCK_KEYS: [number, number] = [72_617, 1];

/**
 * Runs every module's pending migrations under one Postgres advisory lock, so api and worker
 * starting together cannot race. The lock is session scoped, so one dedicated connection holds
 * it for the whole run. A second caller blocks until the first finishes, then finds nothing to do.
 * Tracking tables live in the shared `drizzle` schema, so a module's own schema is created only
 * by that module's SQL.
 */
export async function runMigrationsWithLock(
  databaseUrl: string,
  modules: ModuleMigrations[],
  logger?: Logger,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`select pg_advisory_lock(${LOCK_KEYS[0]}, ${LOCK_KEYS[1]})`;
    try {
      const db = drizzle(sql);
      for (const { name, folder } of modules) {
        await migrate(db, {
          migrationsFolder: folder,
          migrationsSchema: 'drizzle',
          migrationsTable: `${name}_migrations`,
        });
        logger?.info({ module: name }, 'migrations applied');
      }
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEYS[0]}, ${LOCK_KEYS[1]})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
