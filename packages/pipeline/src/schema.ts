import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
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
    /** Job and Target pairs that passed the hard filters and the prerank in this run. */
    prerankPassed: integer('prerank_passed').notNull().default(0),
    /** Job and Target pairs that got an AI fit score in this run (any candidate, not only new ones). */
    scored: integer('scored').notNull().default(0),
    /** Of those, the pairs at or above the alert threshold. */
    tagged: integer('tagged').notNull().default(0),
    /** Review items raised in this run for scores below the threshold (AI fit rejections). */
    aiRejections: integer('ai_rejections').notNull().default(0),
    aiCalls: integer('ai_calls').notNull().default(0),
    /** US dollars the runner reported for this run's AI calls; null when it reported none (unknown, not 0). */
    aiCostUsd: doublePrecision('ai_cost_usd'),
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
