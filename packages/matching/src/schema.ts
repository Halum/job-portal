import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Criteria } from './criteria';
import type { LanguageRequirement } from './scoring';

/** Each module owns one Postgres schema; no other module queries it. */
export const matchingSchema = pgSchema('matching');

// No foreign keys to other modules' schemas: Jobs are referenced by id only.
export const globalDefaults = matchingSchema.table('global_defaults', {
  userId: uuid('user_id').primaryKey(),
  criteria: jsonb('criteria').$type<Criteria>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const targets = matchingSchema.table(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    /** A paused Target stops matching; its criteria and existing candidates stay. */
    paused: boolean('paused').notNull().default(false),
    criteria: jsonb('criteria').$type<Criteria>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('targets_user_name').on(t.userId, t.name)],
);

/** A Job that passed the hard filters and the prerank of a Target. */
export const candidates = matchingSchema.table(
  'candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id),
    jobId: uuid('job_id').notNull(),
    prerankScore: integer('prerank_score').notNull(),
    /** The place could not be resolved, so the radius was not checked. */
    unknownLocation: boolean('unknown_location').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('candidates_target_job').on(t.targetId, t.jobId),
    index('candidates_user_idx').on(t.userId, t.targetId),
  ],
);

/** The AI fit score of one Job against one Target. A pair with no row here is unscored. */
export const scores = matchingSchema.table(
  'scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id),
    jobId: uuid('job_id').notNull(),
    /** 0 to 100, after the language cap. */
    score: integer('score').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    redFlags: jsonb('red_flags').$type<string[]>().notNull(),
    /** What the posting demands, as the model extracted it. */
    languages: jsonb('languages').$type<LanguageRequirement[]>().notNull(),
    /** Judged in code against the Target's language ability; null when the Target sets none. */
    languageMet: boolean('language_met'),
    /** Score at or above the alert threshold when it was scored. */
    tagged: boolean('tagged').notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('scores_target_job').on(t.targetId, t.jobId),
    index('scores_user_idx').on(t.userId, t.targetId),
    check('scores_range', sql`${t.score} between 0 and 100`),
  ],
);
