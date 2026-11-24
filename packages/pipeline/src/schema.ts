import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const pipelineSchema = pgSchema('pipeline');

export const RUN_STATUSES = ['running', 'completed', 'completed_with_errors', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const runs = pipelineSchema.table(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No foreign key to accounts.users: modules never reference each other's schema.
    userId: uuid('user_id').notNull(),
    sourceId: text('source_id').notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    fetched: integer('fetched').notNull().default(0),
    newPostings: integer('new_postings').notNull().default(0),
    errors: jsonb('errors').$type<string[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'runs_status',
      sql`${t.status} in (${sql.raw(RUN_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    // At most one active run per user and source, enforced by the database.
    uniqueIndex('runs_one_running')
      .on(t.userId, t.sourceId)
      .where(sql`${t.status} = 'running'`),
  ],
);
