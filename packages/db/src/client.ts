import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type Db = PostgresJsDatabase;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl);
  return { db: drizzle(sql), close: () => sql.end({ timeout: 5 }) };
}
