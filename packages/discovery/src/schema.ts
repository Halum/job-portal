import { index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const DISCOVERY_STATES = ['new', 'shortlisted', 'dismissed', 'expired'] as const;

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
    /** Normalized company | title | city; null unless all three were present. Null after a split. */
    companyKey: text('company_key'),
    /** The cleaned URL; null after a split. */
    urlKey: text('url_key'),
    /** Dismissed Jobs stay as markers so their Postings never create a new Job. */
    discoveryState: text('discovery_state', { enum: DISCOVERY_STATES }).notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_user_idx').on(t.userId, t.id),
    // Nullable, so postgres allows any number of null keys; these make a duplicate Job impossible.
    unique('jobs_company_key').on(t.userId, t.companyKey),
    unique('jobs_url_key').on(t.userId, t.urlKey),
  ],
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

/** A Posting a split moved out of a Job: rule and AI merges must not put it back. */
export const neverMerge = discoverySchema.table(
  'never_merge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    postingId: uuid('posting_id')
      .notNull()
      .references(() => postings.id),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('never_merge_pair').on(t.postingId, t.jobId)],
);

/** One row per split, so the split count shows whether the merge rule is too loose. */
export const splits = discoverySchema.table('splits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  fromJobId: uuid('from_job_id')
    .notNull()
    .references(() => jobs.id),
  newJobId: uuid('new_job_id')
    .notNull()
    .references(() => jobs.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A Posting whose company key and URL key hit different Jobs; the AI merge ticket reads these. */
export const mergeConflicts = discoverySchema.table('merge_conflicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  postingId: uuid('posting_id')
    .notNull()
    .unique()
    .references(() => postings.id),
  jobIds: uuid('job_ids').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
