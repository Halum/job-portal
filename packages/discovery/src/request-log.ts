import { desc, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { type RequestLog, type RequestLogEntry, type SlotPool } from './sources/jsearch';
import { requestLog } from './schema';

export interface LoggedRequest extends RequestLogEntry {
  requestedAt: Date;
}

/** The request log table: the Source writes every request and reads each pool's last slot back after a restart. */
export function createRequestLog(
  db: Db,
): RequestLog & { recent: (limit?: number) => Promise<LoggedRequest[]> } {
  return {
    async record(entry) {
      await db.insert(requestLog).values(entry);
    },
    async lastSlot(pool: SlotPool) {
      const lower = sql`lower(${requestLog.publisher})`;
      const inPool =
        pool === 'jsearch'
          ? or(isNull(requestLog.publisher), sql`${lower} not in ('linkedin', 'indeed')`)
          : sql`${lower} = ${pool}`;
      const [row] = await db
        .select({ api: requestLog.api, keyPosition: requestLog.keyPosition })
        .from(requestLog)
        .where(inPool)
        .orderBy(desc(requestLog.id))
        .limit(1);
      return row ?? null;
    },
    async recent(limit = 100) {
      const rows = await db.select().from(requestLog).orderBy(desc(requestLog.id)).limit(limit);
      return rows.map(({ id: _id, ...row }) => row);
    },
  };
}
