/** Job lifecycle status, mirrors the `jobs.status` enum in packages/db. Single
 * source of truth — the API zod query validation derives from this tuple. */
export const JOB_STATUSES = ['unenriched', 'matched', 'filtered_out', 'enrichment_failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Prompt role, mirrors the `prompts.role` enum in packages/db. Single source
 * of truth — API zod validation derives from this tuple. */
export const PROMPT_ROLES = ['filter', 'summary'] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

/** Failure stage, mirrors the `errors.stage` enum in packages/db. Single
 * source of truth — the API zod query validation derives from this tuple. */
export const ERROR_STAGES = ['scrape', 'enrichment', 'webhook'] as const;
export type ErrorStage = (typeof ERROR_STAGES)[number];

/** Source types supported by the scraper adapters (PRD §9). Single source of
 * truth — the config zod enum and the scrapers package both derive from this. */
export const SOURCE_TYPES = ['arbeitsagentur', 'feki'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** BullMQ scrape-queue job payload. Single source of truth for both
 * producers (worker's cron registration, api's /api/admin/rescrape) and the
 * worker's consumer, so they can't drift out of sync with each other. */
export interface ScrapePayload {
  sourceName: string;
  sourceType: SourceType;
  url: string;
}

/** BullMQ enrichment-queue job payload. */
export interface EnrichmentPayload {
  jobId: number;
}

export interface FilterPassOutput {
  should_notify: boolean;
  reason: string;
}

export interface SummaryPassOutput {
  summary_en: string;
  key_points: string[];
}

export interface EnrichmentJson {
  filter?: FilterPassOutput;
  summary?: SummaryPassOutput;
}

export interface PromptVersions {
  filter?: number;
  summary?: number;
}
