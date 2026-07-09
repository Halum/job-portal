import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';

export const errorStageEnum = pgEnum('error_stage', ['scrape', 'enrichment', 'webhook']);

export const errors = pgTable(
  'errors',
  {
    id: serial('id').primaryKey(),

    // Nullable: enrichment errors have a job_id but not always a source-level
    // context; webhook errors may have neither.
    source: text('source'),
    jobId: bigint('job_id', { mode: 'number' }).references(() => jobs.id),

    stage: errorStageEnum('stage').notNull(),
    attempts: integer('attempts').notNull(),
    errorMessage: text('error_message').notNull(),
    errorStack: text('error_stack'),
    payload: jsonb('payload'),
    webhookDelivered: boolean('webhook_delivered').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Supports the admin /api/errors window-pagination pattern (PRD §12).
    index('errors_stage_created_at_idx').on(table.stage, table.createdAt),
  ],
);
