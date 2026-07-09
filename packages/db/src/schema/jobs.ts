import {
  bigserial,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status', [
  'unenriched',
  'matched',
  'filtered_out',
  'enrichment_failed',
]);

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    // Dedupe identity — set by the scrape adapter, stable across polls.
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),

    // Normalized fields, extracted from `raw` at insert time. Kept as real
    // columns (rather than only inside `raw`) because the pull API (PRD §12)
    // returns them directly without needing to reach into JSONB.
    title: text('title').notNull(),
    company: text('company'),
    location: text('location'),
    applyUrl: text('apply_url').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),

    // Full adapter payload, exactly as fetched.
    raw: jsonb('raw').notNull(),

    status: jobStatusEnum('status').notNull().default('unenriched'),

    // { filter: { should_notify, reason }, summary: { summary_en, key_points } }
    enrichmentJson: jsonb('enrichment_json'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    enrichedAt: timestamp('enriched_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('jobs_source_external_id_unique').on(table.source, table.externalId),
    // Supports the pull API window filter (status, enriched_at range) with a
    // stable (enriched_at, id) sort for deterministic offset pagination.
    index('jobs_status_enriched_at_id_idx').on(table.status, table.enrichedAt, table.id),
  ],
);
