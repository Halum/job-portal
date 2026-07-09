import type { InferInsertModel } from 'drizzle-orm';
import type { Database } from '../client.js';
import { jobs } from '../schema/jobs.js';

/** Columns the scrape pipeline sets on insert; the rest default (status,
 * timestamps) or stay null (enrichment_json, prompt_versions, enriched_at). */
export type NewJobRow = Pick<
  InferInsertModel<typeof jobs>,
  'source' | 'externalId' | 'title' | 'company' | 'location' | 'applyUrl' | 'postedAt' | 'raw'
>;

/**
 * Bulk INSERT ... ON CONFLICT (source, external_id) DO NOTHING (PRD §10).
 * Returns the ids of rows that were actually inserted — existing (deduped)
 * rows are skipped and excluded from the result, so the caller can enqueue
 * enrichment only for genuinely new postings.
 */
export async function insertNewJobs(db: Database, rows: NewJobRow[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(jobs)
    .values(rows)
    .onConflictDoNothing({ target: [jobs.source, jobs.externalId] })
    .returning({ id: jobs.id });
  return inserted.map((r) => r.id);
}
