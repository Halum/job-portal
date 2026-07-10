import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { JobStatus } from '@job-portal/shared';
import type { Database } from '../client.js';
import { jobs } from '../schema/jobs.js';
import type { FilterPassOutput, SummaryPassOutput } from '@job-portal/llm';

export type Job = InferSelectModel<typeof jobs>;

export interface ListJobsWindow {
  status: JobStatus;
  source?: string;
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

/**
 * Window pagination over enriched jobs (PRD §12). Filters
 * `enriched_at >= from AND enriched_at < to AND status = <status>
 * [AND source = <source>]`, ordered `enriched_at ASC, id ASC` — the stable
 * sort is what makes offset pagination deterministic within a fixed window.
 */
export async function listJobsWindow(db: Database, w: ListJobsWindow): Promise<Job[]> {
  const conditions = [
    eq(jobs.status, w.status),
    gte(jobs.enrichedAt, w.from),
    lt(jobs.enrichedAt, w.to),
  ];
  if (w.source !== undefined) conditions.push(eq(jobs.source, w.source));

  return db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(asc(jobs.enrichedAt), asc(jobs.id))
    .limit(w.limit)
    .offset(w.offset);
}

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

export interface SelectJobIdsFilter {
  source?: string;
  status?: JobStatus;
  from?: Date;
  to?: Date;
}

/**
 * Selects job ids for the reenrich admin endpoint (PRD §12). Filters by any
 * provided subset; the time window is on `created_at` (when we first ingested
 * the row) rather than `enriched_at`, so never-enriched jobs are reachable
 * for a re-run. No safety cap — the caller asked, we return everything.
 */
export async function selectJobIds(db: Database, f: SelectJobIdsFilter): Promise<number[]> {
  const conditions = [];
  if (f.source !== undefined) conditions.push(eq(jobs.source, f.source));
  if (f.status !== undefined) conditions.push(eq(jobs.status, f.status));
  if (f.from !== undefined) conditions.push(gte(jobs.createdAt, f.from));
  if (f.to !== undefined) conditions.push(lt(jobs.createdAt, f.to));

  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(jobs.id));
  return rows.map((r) => r.id);
}

/** Fetches one job row by id, or null if it doesn't exist. */
export async function getJobById(db: Database, id: number): Promise<Job | null> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Filter pass said no (PRD §11 step 5): terminal, not a failure. */
export async function markFilteredOut(
  db: Database,
  id: number,
  filterOutput: FilterPassOutput,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'filtered_out',
      enrichmentJson: { filter: filterOutput },
      enrichedAt: sql`now()`,
    })
    .where(eq(jobs.id, id));
}

/** Both passes completed and the filter pass said yes (PRD §11 step 7). */
export async function markMatched(
  db: Database,
  id: number,
  filterOutput: FilterPassOutput,
  summaryOutput: SummaryPassOutput,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'matched',
      enrichmentJson: { filter: filterOutput, summary: summaryOutput },
      enrichedAt: sql`now()`,
    })
    .where(eq(jobs.id, id));
}

/** Enrichment could not run at all (missing prompt, or retries exhausted).
 * `enrichedAt` stays null — the job was never actually enriched. */
export async function markEnrichmentFailed(db: Database, id: number): Promise<void> {
  await db.update(jobs).set({ status: 'enrichment_failed' }).where(eq(jobs.id, id));
}
