import { index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const discoverySchema = pgSchema('discovery');

// No foreign key to accounts.users: modules never reference each other's schema.
export const jobs = discoverySchema.table(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    company: text('company'),
    location: text('location'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_user_idx').on(t.userId, t.id)],
);

export const postings = discoverySchema.table(
  'postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    sourceId: text('source_id').notNull(),
    sourcePostingId: text('source_posting_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    title: text('title').notNull(),
    company: text('company'),
    location: text('location'),
    url: text('url').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    raw: jsonb('raw').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('postings_identity').on(t.userId, t.sourceId, t.sourcePostingId),
    index('postings_job_idx').on(t.jobId),
  ],
);
