import {
  bigserial,
  date,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const trackerSchema = pgSchema('tracker');

// Job ids point into the discovery schema without a foreign key: modules never reference each other's schema.

/**
 * The application side of a tracked Job, created on its first change; no row means no application.
 * The Job lock every Timeline write takes is the Job row itself, locked through Discovery. The discovery
 * state lives on that Job row in Discovery, written only by the Tracker.
 */
export const jobState = trackerSchema.table(
  'job_state',
  {
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    applicationStatus: text('application_status'),
    furthestStage: text('furthest_stage'),
    /** Calendar dates in the user's timezone, not instants. */
    appliedOn: date('applied_on', { mode: 'string' }),
    applyBy: date('apply_by', { mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jobId] }),
    index('job_state_status_idx').on(t.userId, t.applicationStatus),
  ],
);

/** Every state change; the only write path for one. Rows are never updated or deleted. */
export const timelineEvents = trackerSchema.table(
  'timeline_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull().unique().defaultRandom(),
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    /** 'discovery' or 'application' */
    field: text('field').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    actor: text('actor').notNull(),
    evidence: text('evidence'),
    // What the Job row held before the event, so undo can restore it (furthest stage included).
    furthestBefore: text('furthest_before'),
    appliedOnBefore: date('applied_on_before', { mode: 'string' }),
    applyByBefore: date('apply_by_before', { mode: 'string' }),
    /** Set on an undo event: the event it reverted. */
    undoes: uuid('undoes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('timeline_job_idx').on(t.userId, t.jobId, t.seq)],
);

export const notes = trackerSchema.table(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notes_job_idx').on(t.userId, t.jobId)],
);
