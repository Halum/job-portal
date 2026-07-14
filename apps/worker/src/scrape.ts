import type { Queue } from 'bullmq';
import { getAdapter, type RawJob, type SourceType } from '@job-portal/scrapers';
import { insertNewJobs, type Database, type NewJobRow } from '@job-portal/db';
import type { Logger } from '@job-portal/shared';
import type { SourceEntry } from '@job-portal/config';

const TIMEZONE = 'Europe/Berlin';

export interface ScrapePayload {
  sourceName: string;
  sourceType: SourceType;
  url: string;
}

export interface EnrichmentPayload {
  jobId: number;
}

/** RawJob (adapter output) → jobs table insert row. */
export function mapRawJobToRow(sourceName: string, raw: RawJob): NewJobRow {
  return {
    source: sourceName,
    externalId: raw.externalId,
    title: raw.title,
    company: raw.company ?? null,
    location: raw.location ?? null,
    applyUrl: raw.applyUrl,
    postedAt: raw.postedAt ?? null,
    raw: raw.raw,
  };
}

export interface ScrapeRetryConfig {
  attempts: number;
  backoff_ms: number;
}

/**
 * Register one BullMQ repeatable job per ENABLED source (PRD §10). Idempotent
 * across restarts — BullMQ upserts repeatables by their repeat key. Retry
 * opts are attached here so each cron-produced job inherits them.
 */
export async function registerScrapeJobs(
  scrapeQueue: Pick<Queue, 'add'>,
  sources: SourceEntry[],
  retry: ScrapeRetryConfig,
): Promise<void> {
  for (const s of sources) {
    if (!s.enabled) continue;
    const payload: ScrapePayload = {
      sourceName: s.name,
      sourceType: s.source_type,
      url: s.url,
    };
    await scrapeQueue.add(s.name, payload, {
      repeat: { pattern: s.cron, tz: TIMEZONE },
      attempts: retry.attempts,
      backoff: { type: 'exponential', delay: retry.backoff_ms },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }
}

export interface ScrapeHandlerDeps {
  db: Database;
  enrichmentQueue: Pick<Queue, 'add'>;
  logger: Logger;
}

export interface ScrapeResult {
  fetched: number;
  new: number;
}

/**
 * Scrape job handler (PRD §10): fetch via adapter → dedupe-insert → enqueue
 * enrichment for new rows only → structured log. Throwing propagates to
 * BullMQ, which retries per `retries.scrape` and finally marks the job failed.
 */
export function createScrapeHandler(deps: ScrapeHandlerDeps) {
  return async function handleScrape(payload: ScrapePayload): Promise<ScrapeResult> {
    const start = Date.now();
    const rawJobs = await getAdapter(payload.sourceType).fetch(payload.url);
    const rows = rawJobs.map((r) => mapRawJobToRow(payload.sourceName, r));
    const newIds = await insertNewJobs(deps.db, rows);

    for (const jobId of newIds) {
      await deps.enrichmentQueue.add('enrich', { jobId } satisfies EnrichmentPayload);
    }

    deps.logger.info({
      source: payload.sourceName,
      fetched_count: rawJobs.length,
      new_count: newIds.length,
      duration_ms: Date.now() - start,
    });

    return { fetched: rawJobs.length, new: newIds.length };
  };
}
