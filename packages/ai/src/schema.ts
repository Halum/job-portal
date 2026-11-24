import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const aiSchema = pgSchema('ai');

/** One row per AI call, good or failed. Never holds the prompt or the answer. */
export const calls = aiSchema.table(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No foreign key to accounts.users: modules never reference each other's schema.
    userId: uuid('user_id').notNull(),
    runner: text('runner').notNull(),
    /** The model that answered; null when the call failed before an answer. */
    model: text('model'),
    /** What the call was for, for example fit_score. */
    feature: text('feature').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** US dollars where the runner reports it; null is unknown, 0 is free. */
    costUsd: doublePrecision('cost_usd'),
    durationMs: integer('duration_ms').notNull(),
    outcome: text('outcome').$type<'ok' | 'error'>().notNull(),
    errorClass: text('error_class'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('calls_outcome', sql`${t.outcome} in ('ok', 'error')`),
    index('calls_user_idx').on(t.userId, t.createdAt),
  ],
);
