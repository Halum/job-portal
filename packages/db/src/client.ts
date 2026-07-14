import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbClient {
  db: Database;
  /** Raw postgres.js client — used for health checks and advisory locks. */
  sql: Sql;
  close(): Promise<void>;
}

/**
 * Creates a Drizzle client bound to DATABASE_URL. Callers own the returned
 * client's lifecycle and must call `close()` on shutdown.
 */
export function createDbClient(databaseUrl: string): DbClient {
  const sql = postgres(databaseUrl, {
    // Sane defaults for a small self-hosted service — not tuned for scale.
    max: 10,
    onnotice: () => {
      // Silence Postgres NOTICE spam (e.g. from advisory-lock SQL); real
      // errors still throw.
    },
  });
  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
