import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const reviewSchema = pgSchema('review');

export const REVIEW_KINDS = ['ai_merge', 'ai_fit_rejection', 'mail_match'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = ['pending', 'confirmed', 'disagreed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** What an item is about, as ids of other modules' rows (no foreign keys across schemas). */
export type ReviewSubject = Record<string, string>;

export const items = reviewSchema.table(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<ReviewKind>().notNull(),
    /** ai_fit_rejection: { jobId, targetId }. */
    subject: jsonb('subject').$type<ReviewSubject>().notNull(),
    /** The model that made the AI call this item questions. */
    model: text('model').notNull(),
    status: text('status').$type<ReviewStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    // One item per question: the database arbitrates when two workers raise the same one.
    unique('items_user_kind_subject').on(t.userId, t.kind, t.subject),
    index('items_user_status_idx').on(t.userId, t.status, t.kind),
    check(
      'items_kind',
      sql`${t.kind} in (${sql.raw(REVIEW_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check(
      'items_status',
      sql`${t.status} in (${sql.raw(REVIEW_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
  ],
);
