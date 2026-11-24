import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const mailSchema = pgSchema('mail');

export const OUTCOMES = ['applied', 'noted', 'ignored', 'unmatched', 'review'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The processed-mail ledger: one row per Gmail message id ever handled, keyed by user and message id. It
 * commits in the same transaction as the Timeline event, so a replayed mail changes nothing.
 */
export const processed = mailSchema.table(
  'processed',
  {
    // No foreign key to accounts.users: modules never reference each other's schema.
    userId: uuid('user_id').notNull(),
    messageId: text('message_id').notNull(),
    outcome: text('outcome').$type<Outcome>().notNull(),
    /** The Job the mail was applied or noted on; null otherwise. */
    jobId: uuid('job_id'),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    check(
      'processed_outcome',
      sql`${t.outcome} in (${sql.raw(OUTCOMES.map((o) => `'${o}'`).join(', '))})`,
    ),
  ],
);

/** Job-like mails that matched no Job, kept so nothing is dropped silently. */
export const unmatched = mailSchema.table(
  'unmatched',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    messageId: text('message_id').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    /** The AI's one-sentence summary; empty when no AI call was made. */
    summary: text('summary').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('unmatched_user_message').on(t.userId, t.messageId)],
);

/** What a mail_match Review item is about: the mail, its AI reading and the Jobs it could belong to. */
export const matches = mailSchema.table(
  'matches',
  {
    userId: uuid('user_id').notNull(),
    messageId: text('message_id').notNull(),
    kind: text('kind').notNull(),
    /** The Job the AI picked with low confidence; confirming the item applies the mail to it. */
    suggestedJobId: uuid('suggested_job_id').notNull(),
    candidateJobIds: jsonb('candidate_job_ids').$type<string[]>().notNull(),
    summary: text('summary').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.messageId] })],
);

/** Where the poll resumes, and the lease that keeps two workers from polling one inbox at once. */
export const cursors = mailSchema.table(
  'cursors',
  {
    userId: uuid('user_id').primaryKey(),
    since: timestamp('since', { withTimezone: true }).notNull(),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
  },
  (t) => [index('cursors_lease_idx').on(t.leasedUntil)],
);
