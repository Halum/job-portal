import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type Db = PostgresJsDatabase;
/** The handle inside `db.transaction`; modules pass it to each other so one change stays one transaction. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl);
  return { db: drizzle(sql), close: () => sql.end({ timeout: 5 }) };
}
