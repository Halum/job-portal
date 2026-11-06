import type { Queue } from 'bullmq';
import { getAdapter, type RawJob } from '@job-portal/scrapers';
import { insertNewJobs, type Database, type NewJobRow } from '@job-portal/db';
import type { EnrichmentPayload, Logger, ScrapePayload } from '@job-portal/shared';
import type { SourceEntry } from '@job-portal/config';

const TIMEZONE = 'Europe/Berlin';

export type { EnrichmentPayload, ScrapePayload };

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
 * Register one BullMQ repeatable job per ENABLED source (PRD §10). BullMQ
 * keys a repeatable by name + cron pattern, so a changed cron (or a removed/
 * disabled source) would otherwise leave the old schedule running forever
 * alongside the new one — prune any repeatable that doesn't match a current
 * enabled source's {name, cron} exactly before re-registering.
 */
export async function registerScrapeJobs(
  scrapeQueue: Pick<Queue, 'add' | 'getRepeatableJobs' | 'removeRepeatableByKey'>,
  sources: SourceEntry[],
  retry: ScrapeRetryConfig,
): Promise<void> {
  const enabled = sources.filter((s) => s.enabled);
  const desired = new Set(enabled.map((s) => `${s.name}::${s.cron}`));

  const existing = await scrapeQueue.getRepeatableJobs();
  for (const job of existing) {
    if (!job.pattern || !desired.has(`${job.name}::${job.pattern}`)) {
      await scrapeQueue.removeRepeatableByKey(job.key);
    }
  }

  for (const s of enabled) {
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
