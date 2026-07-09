import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Logger } from '@job-portal/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixed advisory-lock key for migrations. Arbitrary constant, unique enough
 * to not collide with anything else this app (or a human DBA) might lock.
 * Two int32 keys (rather than one bigint) sidestep JS bigint/postgres.js
 * param-binding friction.
 */
const MIGRATION_LOCK_KEYS: [number, number] = [72_617, 1];

export interface RunMigrationsOptions {
  /** Folder containing Drizzle-generated SQL migrations. */
  migrationsFolder?: string;
  logger?: Logger;
  /** How long to wait for the lock holder to finish before giving up, in ms. */
  waitTimeoutMs?: number;
  /** Poll interval while waiting for the lock, in ms. */
  pollIntervalMs?: number;
}

/**
 * Runs pending migrations guarded by a Postgres advisory lock so that
 * parallel `api` + `worker` startups don't race each other (PRD §8, §15).
 *
 * Opens its own single-connection (`max: 1`) postgres.js client for the
 * duration of the call — migrations must run over a dedicated connection,
 * and the same connection is reused to hold the advisory lock (advisory
 * locks are session-scoped, so lock + migrate + unlock must share one
 * connection).
 *
 * Behavior:
 * - Try to acquire the advisory lock (non-blocking, `pg_try_advisory_lock`).
 * - If acquired: run migrations, then release the lock.
 * - If not acquired (another process holds it): poll until the lock is
 *   released, then return without running migrations ourselves — the lock
 *   holder is assumed to have completed them.
 */
export async function runMigrationsWithLock(
  databaseUrl: string,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const {
    migrationsFolder = path.join(__dirname, '..', 'drizzle'),
    logger,
    waitTimeoutMs = 60_000,
    pollIntervalMs = 500,
  } = options;

  const [key1, key2] = MIGRATION_LOCK_KEYS;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Fast path: we hold the lock, run migrations under it.
    if (await tryAcquireLock(sql, key1, key2)) {
      logger?.info({ migrationsFolder }, 'acquired migration lock, running migrations');
      try {
        await runMigrate(sql, migrationsFolder);
        logger?.info('migrations complete');
      } finally {
        await releaseLock(sql, key1, key2);
      }
      return;
    }

    // Another process holds the lock. Poll until we can acquire it, then run
    // the (idempotent, __drizzle_migrations-guarded) migrate ourselves before
    // releasing. We deliberately do NOT assume the previous holder finished:
    // Postgres auto-releases a session-scoped advisory lock if that process
    // crashes mid-migration, which would otherwise leave a half-applied
    // schema we'd wrongly treat as complete. Re-running is a no-op when the
    // schema is already current.
    logger?.info('migration lock held by another process, waiting for it to be released');
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      if (await tryAcquireLock(sql, key1, key2)) {
        logger?.info('acquired migration lock after waiting, running migrations');
        try {
          await runMigrate(sql, migrationsFolder);
          logger?.info('migrations complete');
        } finally {
          await releaseLock(sql, key1, key2);
        }
        return;
      }
    }

    throw new Error(
      `Timed out after ${waitTimeoutMs}ms waiting for migration lock held by another process`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runMigrate(sql: postgres.Sql, migrationsFolder: string): Promise<void> {
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder });
}

async function tryAcquireLock(
  sql: postgres.Sql,
  key1: number,
  key2: number,
): Promise<boolean> {
  const rows = await sql<{ pg_try_advisory_lock: boolean }[]>`
    select pg_try_advisory_lock(${key1}, ${key2}) as pg_try_advisory_lock
  `;
  return rows[0]?.pg_try_advisory_lock ?? false;
}

async function releaseLock(sql: postgres.Sql, key1: number, key2: number): Promise<void> {
  await sql`select pg_advisory_unlock(${key1}, ${key2})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
